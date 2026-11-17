import { useEffect } from 'react';

const SHORTCUTS: Array<[string, string]> = [
  ['V', 'Select (Shift+click adds)'],
  ['N', 'Add node'],
  ['M', 'Draw member'],
  ['P', 'Draw plate'],
  ['S', 'Support tool'],
  ['L', 'Load tool'],
  ['X', 'Delete tool'],
  ['Del', 'Delete selection'],
  ['Esc', 'Cancel / deselect'],
  ['Ctrl+Z', 'Undo'],
  ['Ctrl+Shift+Z', 'Redo'],
  ['1 … 6', 'N, Vy, Vz, T, My, Mz diagram'],
  ['0', 'Hide member diagrams'],
  ['C', 'Next contour plot'],
  ['D', 'Toggle deformed shape'],
  ['R', 'Toggle reactions'],
  ['F', 'Fit model to window'],
  ['G', 'Toggle snap to grid'],
  ['Drag', 'Orbit'],
  ['Right-drag', 'Pan'],
  ['Scroll / pinch', 'Zoom'],
  ['?', 'This help'],
];

export function Help3D({ onClose }: { onClose: () => void }) {
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
        aria-label="3D help"
        onClick={(e) => e.stopPropagation()}
      >
        <h2>FrameForge 3D help</h2>
        <p className="muted">
          Model space frames, trusses, plates (flat shells) and solids (8-node bricks). Pick an
          example, or generate a frame, a plate mesh or a solid block from the Generate tab, add
          supports and loads, and the results update as you edit. Everything runs in your browser.
        </p>
        <h4>Keyboard and mouse</h4>
        <div className="shortcut-grid">
          {SHORTCUTS.map(([key, label]) => (
            <div key={key}>
              <kbd>{key}</kbd>
              <span>{label}</span>
            </div>
          ))}
        </div>
        <h4>Axes and sign conventions</h4>
        <p className="muted">
          Global axes are right-handed with Y up, so gravity loads are negative Y values. Member
          local x runs from node i to node j; local y is &ldquo;web up&rdquo; (towards +Y) unless
          the roll angle β turns it. Mz bends a member in its local x–y plane (major axis), My in
          the x–z plane; moment diagrams are drawn on the tension side. Axial force is positive in
          tension. Plate moments and stresses are in each plate&rsquo;s local axes; solid stresses
          are global. Units: kN, m, kN·m; plate thickness mm; stresses MPa.
        </p>
        <h4>2D and 3D</h4>
        <p className="muted">
          Use the 2D | 3D switch to change workspace; each keeps its own model. &ldquo;Open in
          3D&rdquo; in the 2D workspace converts a plane model into the z = 0 plane.
        </p>
        <div className="button-row end">
          <button type="button" className="primary" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
