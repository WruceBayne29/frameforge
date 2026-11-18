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
  ['1 … 6', 'N, Vy, Vz, T, My, Mz diagram (plane frames: 1, 2, 6)'],
  ['0', 'Hide member diagrams'],
  ['C', 'Next contour plot'],
  ['D', 'Toggle deformed shape'],
  ['R', 'Toggle reactions'],
  ['U', 'Toggle IS 800 utilisation colours'],
  ['F', 'Fit model to window'],
  ['G', 'Toggle snap to grid'],
  ['Drag', 'Orbit (plane frames: drag a node to move it)'],
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
        aria-label="Help"
        onClick={(e) => e.stopPropagation()}
      >
        <h2>FrameForge help</h2>
        <p className="muted">
          Model space frames, trusses, plates (flat shells) and solids (8-node bricks), or plane
          frames and trusses in 2D. Pick an example, or generate a frame, a plate mesh or a solid
          block from the Generate tab, add supports and loads, and the results update as you edit.
          Everything runs in your browser.
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
        <h4>Plane frames (2D)</h4>
        <p className="muted">
          For flat frames, beams and trusses, tick &ldquo;Plane frame (XY)&rdquo; in Properties
          (with nothing selected) or choose New → Plane frame. The model then lies in the z = 0
          plane and only moves in it: the view is a fixed front view, nodes are drawn on z = 0 and
          can be dragged with the select tool, and only N, Vy and Mz are shown. Files, share links
          and saved models from the former 2D app open as plane frames.
        </p>
        <h4>Design, dynamics and reports</h4>
        <p className="muted">
          The Design tab checks every ISMB / ISMC member to IS 800:2007 (biaxial bending, both
          buckling axes; torsion is not checked). The Advanced tab computes natural frequencies with
          animated mode shapes and influence lines for a moving unit load. PDF report downloads a
          calculation report with inputs, results, diagrams and design checks.
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
