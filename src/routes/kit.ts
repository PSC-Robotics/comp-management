import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { adminEmail, requireAdmin } from '../auth/sessions.js';
import { audit } from '../db/audit.js';
import { pool, transaction } from '../db/pool.js';
import { findCompetition } from '../services/competitions.js';

/** Condition of an item; returning kit records the condition it came back in. */
const conditionSchema = z.enum(['good', 'worn', 'damaged', 'faulty', 'lost', 'retired']);
const returnConditionSchema = z.enum(['good', 'worn', 'damaged', 'faulty', 'lost']);
const text = (max: number) => z.string().trim().max(max);

/** Every item with the team that has it (if any), newest first within each category. */
async function listKit(competitionId: string) {
  const result = await pool.query(
    `SELECT k.id, k.name, k.category, k.asset_tag, k.notes, k.condition, k.created_at, k.updated_at,
            l.id AS loan_id, l.checked_out_at, l.checked_out_by, l.due_back_at, l.out_notes,
            t.id AS team_id, t.code AS team_code, t.name AS team_name,
            (SELECT count(*)::int FROM kit_loans past WHERE past.kit_item_id = k.id) AS loan_count
     FROM kit_items k
     LEFT JOIN kit_loans l ON l.kit_item_id = k.id AND l.returned_at IS NULL
     LEFT JOIN teams t ON t.id = l.team_id
     WHERE k.competition_id = $1
     ORDER BY lower(k.category), lower(k.name), k.created_at`,
    [competitionId]
  );
  return result.rows.map((row) => ({
    ...row,
    status: row.loan_id ? 'checked_out'
      : row.condition === 'lost' ? 'lost'
        : row.condition === 'retired' ? 'retired'
          : ['damaged', 'faulty'].includes(row.condition) ? 'needs_repair' : 'available',
    overdue: Boolean(row.loan_id && row.due_back_at && new Date(row.due_back_at).getTime() < Date.now())
  }));
}

/** The item, locked, if it belongs to a competition this request may change. */
async function lockItem(client: PoolClient, itemId: string) {
  const result = await client.query<{ id: string; competition_id: string; name: string; condition: string }>(
    'SELECT id, competition_id, name, condition FROM kit_items WHERE id = $1 FOR UPDATE', [itemId]
  );
  return result.rows[0];
}

export function registerKitRoutes(app: FastifyInstance): void {
  app.get('/api/admin/competitions/:slug/kit', { preHandler: requireAdmin }, async (request, reply) => {
    const { slug } = z.object({ slug: z.string() }).parse(request.params);
    const competition = await findCompetition(pool, slug);
    if (!competition) return reply.code(404).send({ error: 'Competition not found' });
    return listKit(competition.id);
  });

  // Adds one item, or several identical ones numbered #1, #2, … (asset tags get -1, -2, …).
  app.post('/api/admin/competitions/:slug/kit', { preHandler: requireAdmin }, async (request, reply) => {
    const { slug } = z.object({ slug: z.string() }).parse(request.params);
    const body = z.object({
      name: text(120).min(1),
      category: text(80).default(''),
      assetTag: text(80).default(''),
      notes: text(1000).default(''),
      condition: conditionSchema.default('good'),
      quantity: z.number().int().min(1).max(200).default(1)
    }).parse(request.body);
    const competition = await findCompetition(pool, slug);
    if (!competition) return reply.code(404).send({ error: 'Competition not found' });
    const ids: string[] = [];
    await transaction(async (client) => {
      for (let index = 1; index <= body.quantity; index += 1) {
        const id = randomUUID();
        ids.push(id);
        const suffix = body.quantity > 1;
        await client.query(
          `INSERT INTO kit_items (id, competition_id, name, category, asset_tag, notes, condition)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [id, competition.id, suffix ? `${body.name} #${index}` : body.name, body.category,
            body.assetTag && suffix ? `${body.assetTag}-${index}` : body.assetTag, body.notes, body.condition]
        );
      }
      await audit(client, adminEmail(request), 'kit.added', 'competition', competition.id, {
        name: body.name, quantity: body.quantity, category: body.category
      });
    });
    return reply.code(201).send({ ids });
  });

  app.patch('/api/admin/kit/:itemId', { preHandler: requireAdmin }, async (request, reply) => {
    const { itemId } = z.object({ itemId: z.string().uuid() }).parse(request.params);
    const body = z.object({
      name: text(120).min(1).optional(),
      category: text(80).optional(),
      assetTag: text(80).optional(),
      notes: text(1000).optional(),
      condition: conditionSchema.optional()
    }).refine((value) => Object.keys(value).length > 0).parse(request.body);
    const outcome = await transaction(async (client) => {
      const item = await lockItem(client, itemId);
      if (!item) return { status: 404, error: 'Kit item not found' };
      await client.query(
        `UPDATE kit_items SET name = coalesce($2, name), category = coalesce($3, category),
           asset_tag = coalesce($4, asset_tag), notes = coalesce($5, notes),
           condition = coalesce($6, condition), updated_at = now()
         WHERE id = $1`,
        [itemId, body.name ?? null, body.category ?? null, body.assetTag ?? null, body.notes ?? null, body.condition ?? null]
      );
      await audit(client, adminEmail(request), 'kit.updated', 'kit_item', itemId, body);
      return { status: 200, ok: true };
    });
    return reply.code(outcome.status).send(outcome);
  });

  app.delete('/api/admin/kit/:itemId', { preHandler: requireAdmin }, async (request, reply) => {
    const { itemId } = z.object({ itemId: z.string().uuid() }).parse(request.params);
    const outcome = await transaction(async (client) => {
      const item = await lockItem(client, itemId);
      if (!item) return { status: 404, error: 'Kit item not found' };
      const open = await client.query('SELECT 1 FROM kit_loans WHERE kit_item_id = $1 AND returned_at IS NULL', [itemId]);
      if (open.rowCount) return { status: 409, error: 'Check this item back in before deleting it' };
      await client.query('DELETE FROM kit_items WHERE id = $1', [itemId]);
      await audit(client, adminEmail(request), 'kit.deleted', 'kit_item', itemId, { name: item.name });
      return { status: 204 };
    });
    if (outcome.status === 204) return reply.code(204).send();
    return reply.code(outcome.status).send(outcome);
  });

  app.post('/api/admin/kit/:itemId/checkout', { preHandler: requireAdmin }, async (request, reply) => {
    const { itemId } = z.object({ itemId: z.string().uuid() }).parse(request.params);
    const body = z.object({
      teamCode: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/),
      dueBackAt: z.string().datetime({ offset: true }).optional(),
      notes: text(1000).default('')
    }).parse(request.body);
    const outcome = await transaction(async (client) => {
      const item = await lockItem(client, itemId);
      if (!item) return { status: 404, error: 'Kit item not found' };
      if (['lost', 'retired'].includes(item.condition)) {
        return { status: 409, error: `This item is marked ${item.condition}; change its condition before lending it` };
      }
      const open = await client.query('SELECT 1 FROM kit_loans WHERE kit_item_id = $1 AND returned_at IS NULL', [itemId]);
      if (open.rowCount) return { status: 409, error: 'This item is already checked out; check it in first' };
      const team = await client.query<{ id: string }>(
        'SELECT id FROM teams WHERE competition_id = $1 AND code = $2', [item.competition_id, body.teamCode]
      );
      if (!team.rows[0]) return { status: 400, error: `No team ${body.teamCode} in this competition` };
      const loanId = randomUUID();
      await client.query(
        `INSERT INTO kit_loans (id, kit_item_id, team_id, checked_out_by, due_back_at, out_notes)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [loanId, itemId, team.rows[0].id, adminEmail(request), body.dueBackAt ?? null, body.notes]
      );
      await audit(client, adminEmail(request), 'kit.checked_out', 'kit_item', itemId, {
        name: item.name, team: body.teamCode, dueBackAt: body.dueBackAt ?? null
      });
      return { status: 200, loanId };
    });
    return reply.code(outcome.status).send(outcome);
  });

  // Checking in records the condition the item came back in, which becomes its status
  // (lost: it never came back).
  app.post('/api/admin/kit/:itemId/checkin', { preHandler: requireAdmin }, async (request, reply) => {
    const { itemId } = z.object({ itemId: z.string().uuid() }).parse(request.params);
    const body = z.object({ condition: returnConditionSchema, notes: text(1000).default('') }).parse(request.body);
    const outcome = await transaction(async (client) => {
      const item = await lockItem(client, itemId);
      if (!item) return { status: 404, error: 'Kit item not found' };
      const loan = await client.query<{ id: string; team_code: string }>(
        `SELECT l.id, t.code AS team_code FROM kit_loans l JOIN teams t ON t.id = l.team_id
         WHERE l.kit_item_id = $1 AND l.returned_at IS NULL FOR UPDATE OF l`, [itemId]
      );
      if (!loan.rows[0]) return { status: 409, error: 'This item is not checked out' };
      await client.query(
        `UPDATE kit_loans SET returned_at = now(), returned_by = $2, return_condition = $3, return_notes = $4
         WHERE id = $1`,
        [loan.rows[0].id, adminEmail(request), body.condition, body.notes]
      );
      await client.query('UPDATE kit_items SET condition = $2, updated_at = now() WHERE id = $1', [itemId, body.condition]);
      await audit(client, adminEmail(request), 'kit.checked_in', 'kit_item', itemId, {
        name: item.name, team: loan.rows[0].team_code, condition: body.condition
      });
      return { status: 200, ok: true };
    });
    return reply.code(outcome.status).send(outcome);
  });

  app.get('/api/admin/kit/:itemId/history', { preHandler: requireAdmin }, async (request, reply) => {
    const { itemId } = z.object({ itemId: z.string().uuid() }).parse(request.params);
    const item = await pool.query('SELECT id FROM kit_items WHERE id = $1', [itemId]);
    if (!item.rowCount) return reply.code(404).send({ error: 'Kit item not found' });
    const result = await pool.query(
      `SELECT l.id, t.code AS team_code, t.name AS team_name, l.checked_out_at, l.checked_out_by, l.due_back_at,
              l.out_notes, l.returned_at, l.returned_by, l.return_condition, l.return_notes
       FROM kit_loans l JOIN teams t ON t.id = l.team_id
       WHERE l.kit_item_id = $1 ORDER BY l.checked_out_at DESC`,
      [itemId]
    );
    return result.rows;
  });
}
