import { playoffStages, type BracketSide } from './playoffs.js';

export type DiagramHeat = {
  id: string;
  number: number;
  side: BracketSide;
  /** Raw sources: `seed:N`, `place:R:<heat id>` or `bye`. */
  sources: string[];
  /** Team code in each source slot, when known. */
  teams?: (string | null)[];
  /** Final placings once scored, best first. */
  results?: { team: string; points: number | string }[] | null;
  /** Places that progress along the winning path (null for the final). */
  advancing: number | null;
  /** Short status or time shown in the heat header, e.g. "18:53" or "Live". */
  status?: string;
  arena?: string;
  live?: boolean;
};

export type DiagramOptions = {
  format?: string | null;
  /** Eliminated team codes, struck through in results. */
  eliminated?: string[];
};

const BOX_WIDTH = 188;
const COLUMN_GAP = 68;
const HEADER_HEIGHT = 36;
const ROW_HEIGHT = 20;
const BOX_PADDING = 8;
const VERTICAL_GAP = 18;
const BAND_GAP = 46;
const BAND_LABEL = 24;
const MARGIN = 12;

function escapeXml(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[character]!);
}

function ordinal(place: number): string {
  const suffix = place % 100 >= 11 && place % 100 <= 13 ? 'th'
    : ({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[place % 10] ?? 'th';
  return `${place}${suffix}`;
}

type Placed = DiagramHeat & {
  stage: number;
  band: 'upper' | 'lower' | 'final';
  rows: number;
  height: number;
  x: number;
  y: number;
};

/**
 * Draws a playoff bracket as a standalone SVG: one box per heat arranged in
 * stage columns (upper/knockout band on top, lower bracket below, final on
 * the right) with a line from each feeding heat to the entrant slot it fills.
 * Solid lines follow the winning path; dashed lines drop to the lower bracket.
 */
export function renderBracketDiagram(heats: DiagramHeat[], options: DiagramOptions = {}): string {
  if (!heats.length) return '';
  // Upper/lower wording whenever the bracket has a lower half (double elimination or a custom bracket).
  const twoSided = options.format === 'double-elimination' || heats.some((heat) => heat.side === 'lower');
  const stages = playoffStages(heats.map((heat) => ({ key: heat.id, sources: heat.sources })));
  const numberById = new Map(heats.map((heat) => [heat.id, heat.number]));
  const eliminated = new Set(options.eliminated ?? []);
  const placed: Placed[] = heats.map((heat) => {
    const rows = Math.max(2, heat.sources.filter((source) => source !== 'bye').length);
    const stage = stages.get(heat.id) ?? 1;
    return {
      ...heat,
      stage,
      band: heat.side,
      rows,
      height: HEADER_HEIGHT + rows * ROW_HEIGHT + BOX_PADDING,
      x: MARGIN + (stage - 1) * (BOX_WIDTH + COLUMN_GAP),
      y: 0
    };
  });
  const byId = new Map(placed.map((heat) => [heat.id, heat]));
  const feeders = (heat: Placed) => [...new Set(heat.sources
    .map((source) => /^place:\d:(.+)$/.exec(source)?.[1])
    .filter((id): id is string => id !== undefined && byId.has(id)))].map((id) => byId.get(id)!);
  const centre = (heat: Placed) => heat.y + heat.height / 2;
  const maxStage = Math.max(...placed.map((heat) => heat.stage));

  // Lay out a band column by column; each heat aims for the average height of
  // the heats feeding it from the same band, then overlaps are pushed down.
  const layoutBand = (band: 'upper' | 'lower', top: number): number => {
    let bottom = top;
    for (let stage = 1; stage <= maxStage; stage += 1) {
      const column = placed.filter((heat) => heat.band === band && heat.stage === stage);
      const desired = new Map(column.map((heat) => {
        const sameBand = feeders(heat).filter((feeder) => feeder.band === band);
        return [heat.id, sameBand.length
          ? sameBand.reduce((sum, feeder) => sum + centre(feeder), 0) / sameBand.length
          : Number.NaN];
      }));
      column.sort((left, right) => {
        const a = desired.get(left.id)!;
        const b = desired.get(right.id)!;
        if (Number.isNaN(a) || Number.isNaN(b)) return left.number - right.number;
        return a - b || left.number - right.number;
      });
      let next = top;
      for (const heat of column) {
        const wanted = desired.get(heat.id)!;
        heat.y = Math.max(next, Number.isNaN(wanted) ? next : wanted - heat.height / 2);
        next = heat.y + heat.height + VERTICAL_GAP;
        bottom = Math.max(bottom, heat.y + heat.height);
      }
    }
    return bottom;
  };

  const hasLower = placed.some((heat) => heat.band === 'lower');
  const upperTop = MARGIN + (hasLower ? BAND_LABEL : 0);
  const upperBottom = layoutBand('upper', upperTop);
  const lowerTop = upperBottom + BAND_GAP + BAND_LABEL;
  const lowerBottom = hasLower ? layoutBand('lower', lowerTop) : upperBottom;
  for (const heat of placed.filter((candidate) => candidate.band === 'final')) {
    const feeding = feeders(heat);
    const target = feeding.length
      ? feeding.reduce((sum, feeder) => sum + centre(feeder), 0) / feeding.length
      : upperTop + heat.height / 2;
    heat.y = Math.max(MARGIN, target - heat.height / 2);
  }

  const width = MARGIN * 2 + maxStage * BOX_WIDTH + (maxStage - 1) * COLUMN_GAP;
  const height = Math.ceil(Math.max(lowerBottom, ...placed.map((heat) => heat.y + heat.height)) + MARGIN);
  const rowY = (heat: Placed, row: number) => heat.y + HEADER_HEIGHT + row * ROW_HEIGHT + ROW_HEIGHT / 2;

  const edges: string[] = [];
  for (const target of placed) {
    target.sources.filter((source) => source !== 'bye').forEach((source, slot) => {
      const match = /^place:(\d):(.+)$/.exec(source);
      const from = match ? byId.get(match[2]!) : undefined;
      if (!match || !from) return;
      const place = Number(match[1]);
      const sx = from.x + BOX_WIDTH;
      const sy = rowY(from, Math.min(place, from.rows) - 1);
      const tx = target.x;
      const ty = rowY(target, slot);
      const bend = Math.max(24, (tx - sx) / 2);
      const kind = target.band === 'final' ? 'final'
        : from.band === 'upper' && target.band === 'lower' ? 'drop' : 'win';
      edges.push(`<path class="bd-edge bd-edge-${kind}" d="M${sx} ${sy} C${sx + bend} ${sy}, ${tx - bend} ${ty}, ${tx} ${ty}"/>`);
    });
  }

  const sideLabel = (side: BracketSide) => side === 'final' ? 'Final'
    : side === 'lower' ? 'Lower' : twoSided ? 'Upper' : 'Knockout';
  const describe = (source: string) => {
    if (source.startsWith('seed:')) return `Seed ${source.slice(5)}`;
    const match = /^place:(\d):(.+)$/.exec(source);
    return match ? `${ordinal(Number(match[1]))} · heat ${numberById.get(match[2]!) ?? '?'}` : 'TBD';
  };

  const boxes = placed.map((heat) => {
    const entrants = heat.sources
      .map((source, index) => ({ source, team: heat.teams?.[index] ?? null }))
      .filter((entry) => entry.source !== 'bye');
    const rows = heat.results && heat.results.length
      ? heat.results.map((result, index) => {
        const outcome = heat.side === 'final' ? (index === 0 ? 'champion' : 'placed')
          : index < (heat.advancing ?? 0) ? 'advance'
            : eliminated.has(result.team) ? 'out' : heat.side === 'upper' && twoSided ? 'drop' : 'out';
        return { label: `${index + 1}. ${result.team}`, detail: `${result.points}`, kind: outcome, code: true };
      })
      : entrants.map((entry) => entry.team
        ? { label: entry.team, detail: entry.source.startsWith('seed:') ? describe(entry.source) : '', kind: 'team', code: true }
        : { label: describe(entry.source), detail: '', kind: 'tbd', code: false });
    const rowMarkup = rows.map((row, index) => {
      const y = heat.y + HEADER_HEIGHT + index * ROW_HEIGHT;
      return `<g class="bd-row bd-row-${row.kind}"><rect x="${heat.x + 1}" y="${y}" width="${BOX_WIDTH - 2}" height="${ROW_HEIGHT}"/>`
        + `<text x="${heat.x + 10}" y="${y + 14}" class="${row.code ? 'bd-code' : 'bd-tbd'}">${escapeXml(row.label)}</text>`
        + (row.detail ? `<text x="${heat.x + BOX_WIDTH - 10}" y="${y + 14}" text-anchor="end" class="bd-detail">${escapeXml(row.detail)}</text>` : '')
        + '</g>';
    }).join('');
    const subtitle = [sideLabel(heat.side), heat.arena].filter(Boolean).join(' · ');
    return `<g class="bd-heat bd-${heat.side}${heat.live ? ' bd-live' : ''}${heat.results?.length ? ' bd-done' : ''}">`
      + `<rect class="bd-box" x="${heat.x}" y="${heat.y}" width="${BOX_WIDTH}" height="${heat.height}" rx="6"/>`
      + `<rect class="bd-stripe" x="${heat.x}" y="${heat.y}" width="5" height="${heat.height}" rx="2"/>`
      + `<text x="${heat.x + 12}" y="${heat.y + 16}" class="bd-title">${escapeXml(heat.side === 'final' ? 'Final' : `Heat ${heat.number}`)}</text>`
      + (heat.status ? `<text x="${heat.x + BOX_WIDTH - 10}" y="${heat.y + 16}" text-anchor="end" class="bd-status">${escapeXml(heat.status)}</text>` : '')
      + `<text x="${heat.x + 12}" y="${heat.y + 30}" class="bd-subtitle">${escapeXml(subtitle)}</text>`
      + rowMarkup
      + '</g>';
  }).join('');

  const labels = hasLower
    ? `<text class="bd-band" x="${MARGIN}" y="${upperTop - 8}">${escapeXml(twoSided ? 'UPPER BRACKET' : 'KNOCKOUT')}</text>`
      + `<line class="bd-divider" x1="${MARGIN}" x2="${width - MARGIN}" y1="${upperBottom + BAND_GAP / 2}" y2="${upperBottom + BAND_GAP / 2}"/>`
      + `<text class="bd-band" x="${MARGIN}" y="${lowerTop - 8}">LOWER BRACKET</text>`
    : '';

  return `<svg class="bracket-diagram" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="Playoff bracket diagram">`
    + `<style>
.bracket-diagram{font-family:system-ui,-apple-system,sans-serif}
.bd-box{fill:var(--bd-surface,#fff);stroke:var(--bd-line,#c9d0d8)}
.bd-stripe{fill:var(--bd-upper,#3267d5)}.bd-lower .bd-stripe{fill:var(--bd-lower,#c76a10)}.bd-final .bd-stripe{fill:var(--bd-final,#19875b)}
.bd-live .bd-box{stroke:var(--bd-final,#19875b);stroke-width:2.5}
.bd-title{font-size:13px;font-weight:800;fill:var(--bd-ink,#19212c)}
.bd-status{font-size:11px;font-weight:700;fill:var(--bd-muted,#687384)}
.bd-live .bd-status{fill:var(--bd-final,#19875b)}
.bd-subtitle{font-size:10px;fill:var(--bd-muted,#687384);text-transform:uppercase;letter-spacing:.04em}
.bd-row rect{fill:transparent}
.bd-code{font:700 13px ui-monospace,SFMono-Regular,Menlo,monospace;fill:var(--bd-ink,#19212c)}
.bd-tbd{font-size:11.5px;fill:var(--bd-muted,#687384);font-style:italic}
.bd-detail{font-size:11px;fill:var(--bd-muted,#687384)}
.bd-row-advance rect,.bd-row-champion rect{fill:var(--bd-advance-bg,#e5f5ec)}
.bd-row-advance .bd-code,.bd-row-champion .bd-code{fill:var(--bd-final,#167549)}
.bd-row-drop rect{fill:var(--bd-drop-bg,#fff0e2)}
.bd-row-out .bd-code{fill:var(--bd-muted,#687384);text-decoration:line-through}
.bd-edge{fill:none;stroke-width:1.6;opacity:.75}
.bd-edge-win{stroke:var(--bd-upper,#3267d5)}
.bd-edge-drop{stroke:var(--bd-lower,#c76a10);stroke-dasharray:5 4}
.bd-edge-final{stroke:var(--bd-final,#19875b);stroke-width:2}
.bd-band{font-size:11px;font-weight:800;letter-spacing:.08em;fill:var(--bd-muted,#687384)}
.bd-divider{stroke:var(--bd-line,#c9d0d8);stroke-dasharray:2 4}
</style>`
    + labels
    + `<g class="bd-edges">${edges.join('')}</g>`
    + boxes
    + '</svg>';
}
