import type { SupportKind } from '../../model';
import type { Point } from './view';

/** A straight arrow with its head at `to`. */
export function Arrow({
  from,
  to,
  className,
  head = 8,
}: {
  from: Point;
  to: Point;
  className?: string;
  head?: number;
}) {
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  const len = Math.hypot(dx, dy);
  if (len < 1e-6) return null;
  const ux = dx / len;
  const uy = dy / len;
  const h = Math.min(head, len * 0.6);
  const bx = to[0] - ux * h;
  const by = to[1] - uy * h;
  const w = h * 0.38;
  return (
    <g className={className}>
      <line x1={from[0]} y1={from[1]} x2={bx} y2={by} />
      <polygon
        className="arrow-head"
        points={`${to[0]},${to[1]} ${bx - uy * w},${by + ux * w} ${bx + uy * w},${by - ux * w}`}
      />
    </g>
  );
}

/**
 * A moment drawn as a three-quarter arc with an arrowhead. `ccw` is the sense of the moment
 * as seen on screen.
 */
export function MomentArc({
  at,
  ccw,
  radius = 16,
  className,
}: {
  at: Point;
  ccw: boolean;
  radius?: number;
  className?: string;
}) {
  // Arc from 30° to 300° (screen angles, y down). The head sits at the end of the sweep.
  const a0 = (ccw ? 300 : 240) * (Math.PI / 180);
  const a1 = (ccw ? 30 : 510) * (Math.PI / 180);
  const p0: Point = [at[0] + radius * Math.cos(a0), at[1] + radius * Math.sin(a0)];
  const p1: Point = [at[0] + radius * Math.cos(a1), at[1] + radius * Math.sin(a1)];
  // On screen (y down) increasing angle is clockwise; a counter-clockwise moment sweeps backwards.
  const sweep = ccw ? 0 : 1;
  const tangent: Point = ccw ? [Math.sin(a1), -Math.cos(a1)] : [-Math.sin(a1), Math.cos(a1)];
  const h = 7;
  const bx = p1[0] - tangent[0] * h;
  const by = p1[1] - tangent[1] * h;
  const w = 3.2;
  return (
    <g className={className}>
      <path
        className="moment-arc"
        d={`M ${p0[0]} ${p0[1]} A ${radius} ${radius} 0 1 ${sweep} ${p1[0]} ${p1[1]}`}
      />
      <polygon
        className="arrow-head"
        points={`${p1[0] + tangent[0] * 2},${p1[1] + tangent[1] * 2} ${bx - tangent[1] * w},${by + tangent[0] * w} ${bx + tangent[1] * w},${by - tangent[0] * w}`}
      />
    </g>
  );
}

const S = 13;

/** Support symbol drawn "below" the node, then rotated by `angle` degrees about it. */
export function SupportGlyph({
  at,
  kind,
  angle = 0,
  className = '',
}: {
  at: Point;
  kind: SupportKind;
  angle?: number;
  className?: string;
}) {
  const hatch = (y: number, half: number) =>
    Array.from({ length: 5 }, (_, k) => {
      const x = -half + (k + 0.5) * ((2 * half) / 5);
      return <line key={k} className="hatch" x1={x + 3} y1={y} x2={x - 3} y2={y + 6} />;
    });
  let body;
  if (kind === 'fixed') {
    body = (
      <>
        <line className="ground" x1={-S * 1.2} y1={0} x2={S * 1.2} y2={0} />
        {hatch(0, S * 1.2)}
      </>
    );
  } else if (kind === 'pinned') {
    body = (
      <>
        <polygon
          className="support-body"
          points={`0,0 ${-S * 0.8},${S * 1.3} ${S * 0.8},${S * 1.3}`}
        />
        <line className="ground" x1={-S * 1.2} y1={S * 1.3} x2={S * 1.2} y2={S * 1.3} />
        {hatch(S * 1.3, S * 1.2)}
      </>
    );
  } else {
    body = (
      <>
        <polygon
          className="support-body"
          points={`0,0 ${-S * 0.8},${S * 1.1} ${S * 0.8},${S * 1.1}`}
        />
        <circle className="support-body" cx={-S * 0.45} cy={S * 1.1 + 3.5} r={3} />
        <circle className="support-body" cx={S * 0.45} cy={S * 1.1 + 3.5} r={3} />
        <line className="ground" x1={-S * 1.2} y1={S * 1.1 + 7.5} x2={S * 1.2} y2={S * 1.1 + 7.5} />
      </>
    );
  }
  const rotation = kind === 'rollerY' ? angle + 90 : angle;
  return (
    <g
      className={`support ${className}`}
      transform={`translate(${at[0]} ${at[1]}) rotate(${rotation})`}
    >
      {body}
    </g>
  );
}
