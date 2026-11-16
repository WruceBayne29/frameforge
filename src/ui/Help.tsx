import { useEffect } from 'react';

const SHORTCUTS: Array<[string, string]> = [
  ['V', 'Select / move'],
  ['N', 'Add node'],
  ['M', 'Draw member'],
  ['S', 'Add support'],
  ['L', 'Add load'],
  ['X', 'Delete tool'],
  ['Del', 'Delete selection'],
  ['Esc', 'Cancel / deselect'],
  ['Ctrl+Z', 'Undo'],
  ['Ctrl+Shift+Z', 'Redo'],
  ['1 / 2 / 3', 'Axial / shear / moment diagram'],
  ['0', 'Hide diagrams'],
  ['D', 'Toggle deflected shape'],
  ['R', 'Toggle reactions'],
  ['U', 'Toggle utilisation colours'],
  ['F', 'Fit model to window'],
  ['G', 'Toggle snap to grid'],
  ['Space + drag', 'Pan'],
  ['Scroll', 'Zoom'],
  ['?', 'This help'],
];

export function Help({ onClose, onTour }: { onClose: () => void; onTour: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label="Help"
        onClick={(e) => e.stopPropagation()}
      >
        <h2>FrameForge help</h2>
        <p className="muted">
          Draw a structure with the tools on the left, add supports and loads, and results update
          instantly. Everything runs in your browser — nothing is uploaded.
        </p>
        <h4>Keyboard shortcuts</h4>
        <div className="shortcut-grid">
          {SHORTCUTS.map(([key, label]) => (
            <div key={key}>
              <kbd>{key}</kbd>
              <span>{label}</span>
            </div>
          ))}
        </div>
        <h4>Sign conventions</h4>
        <p className="muted">
          X is to the right, Y is up, moments are positive anticlockwise. A negative Fy or w acts
          downward. Axial force is positive in tension. Bending moment is positive when sagging and
          is drawn on the tension side.
        </p>
        <div className="button-row end">
          <button type="button" onClick={onTour}>
            Take the tour
          </button>
          <button type="button" className="primary" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
