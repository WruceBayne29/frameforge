import { useEffect, useLayoutEffect, useState } from 'react';

interface Step {
  target: string;
  title: string;
  body: string;
}

const STEPS: Step[] = [
  {
    target: 'examples',
    title: 'Start from an example',
    body: 'Pick a beam, frame or truss — including a transmission tower — to see a solved structure straight away.',
  },
  {
    target: 'toolbar',
    title: 'Draw your own structure',
    body: 'Add nodes, members, supports and loads by clicking on the canvas. Points snap to the grid, and every step can be undone.',
  },
  {
    target: 'canvas',
    title: 'Results update live',
    body: 'Drag a node and watch the diagrams change. Hover over any member to read the axial force, shear, moment and deflection at that point.',
  },
  {
    target: 'viewbar',
    title: 'Choose what to see',
    body: 'Switch between axial, shear and bending moment diagrams, show the deflected shape, and colour members by their IS 800 utilisation.',
  },
  {
    target: 'panel',
    title: 'Edit by numbers',
    body: 'Edit the selected item under Properties, type the whole model in under Tables, and read reactions and design checks under Results and Design.',
  },
  {
    target: 'export',
    title: 'Save and share',
    body: 'Save the model as JSON, copy a link that reopens it anywhere, or download a PDF calculation report.',
  },
];

interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** First-run walkthrough: highlights one part of the interface at a time. */
export function Tour({ onClose }: { onClose: () => void }) {
  const [index, setIndex] = useState(0);
  const [rect, setRect] = useState<Rect | null>(null);
  const step = STEPS[index];

  useLayoutEffect(() => {
    const measure = () => {
      const el = document.querySelector(`[data-tour="${step.target}"]`);
      if (!el) {
        setRect(null);
        return;
      }
      const r = el.getBoundingClientRect();
      setRect({ left: r.left, top: r.top, width: r.width, height: r.height });
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [step.target]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'ArrowRight' || e.key === 'Enter') {
        if (index === STEPS.length - 1) onClose();
        else setIndex(index + 1);
      }
      if (e.key === 'ArrowLeft' && index > 0) setIndex(index - 1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [index, onClose]);

  // Place the card next to the highlighted area, keeping it on screen.
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const cardW = Math.min(320, vw - 24);
  const cardH = 190;
  let left = (vw - cardW) / 2;
  let top = (vh - cardH) / 2;
  if (rect) {
    const big = rect.width > vw * 0.5 && rect.height > vh * 0.5;
    if (big) {
      left = rect.left + (rect.width - cardW) / 2;
      top = rect.top + 24;
    } else if (rect.left + rect.width + cardW + 16 < vw && rect.height > 120) {
      left = rect.left + rect.width + 12;
      top = rect.top + 8;
    } else if (rect.left - cardW - 16 > 0 && rect.height > 120) {
      left = rect.left - cardW - 12;
      top = rect.top + 8;
    } else if (rect.top + rect.height + cardH + 16 < vh) {
      left = rect.left;
      top = rect.top + rect.height + 12;
    } else {
      left = rect.left;
      top = rect.top - cardH - 12;
    }
  }
  left = Math.min(Math.max(12, left), vw - cardW - 12);
  top = Math.min(Math.max(12, top), vh - cardH - 12);

  return (
    <div className="tour" role="dialog" aria-modal="true" aria-label="Welcome tour">
      {rect && (
        <div
          className="tour-highlight"
          style={{
            left: rect.left - 4,
            top: rect.top - 4,
            width: rect.width + 8,
            height: rect.height + 8,
          }}
        />
      )}
      {!rect && <div className="tour-dim" />}
      <div className="tour-card" style={{ left, top, width: cardW }}>
        <span className="tour-count">
          {index + 1} / {STEPS.length}
        </span>
        <h3>{step.title}</h3>
        <p>{step.body}</p>
        <div className="button-row end">
          <button type="button" className="ghost" onClick={onClose}>
            Skip
          </button>
          {index > 0 && (
            <button type="button" onClick={() => setIndex(index - 1)}>
              Back
            </button>
          )}
          <button
            type="button"
            className="primary"
            onClick={() => (index === STEPS.length - 1 ? onClose() : setIndex(index + 1))}
          >
            {index === STEPS.length - 1 ? 'Start building' : 'Next'}
          </button>
        </div>
      </div>
    </div>
  );
}
