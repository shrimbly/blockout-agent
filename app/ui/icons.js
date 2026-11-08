// 16px stroke icons. Add new ones in the same style: 1.5 stroke, round caps, currentColor, no fill unless solid.
const s = (d, extra = '') => `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" ${extra}>${d}</svg>`;

export const ICONS = {
  play: s('<path d="M5 3.5v9l7-4.5z" fill="currentColor"/>'),
  pause: s('<path d="M5.5 3.5v9M10.5 3.5v9"/>'),
  start: s('<path d="M4 3.5v9M12 3.5v9L6 8z"/>'),
  key: s('<path d="M8 2.5 13.5 8 8 13.5 2.5 8z"/>'),
  keyAdd: s('<path d="M7 3 11.5 7.5 7 12 2.5 7.5z"/><path d="M12.5 10.5v4M10.5 12.5h4"/>'),
  camera: s('<rect x="1.5" y="4.5" width="9" height="7" rx="1.5"/><path d="m10.5 7 4-2v6l-4-2"/>'),
  orbit: s('<circle cx="8" cy="8" r="2"/><ellipse cx="8" cy="8" rx="6.5" ry="3"/>'),
  move: s('<path d="M8 1.5v13M1.5 8h13M8 1.5 6 3.5M8 1.5l2 2M8 14.5l-2-2M8 14.5l2-2M1.5 8l2-2M1.5 8l2 2M14.5 8l-2-2M14.5 8l-2 2"/>'),
  rotate: s('<path d="M13.5 8A5.5 5.5 0 1 1 11.5 3.8"/><path d="M11.8 1.5v2.6H9.2"/>'),
  scale: s('<rect x="2" y="7" width="7" height="7" rx="1"/><path d="M9 7 14 2M10 2h4v4"/>'),
  trash: s('<path d="M2.5 4h11M6 4V2.5h4V4M4 4l.7 9.5h6.6L12 4"/>'),
  copy: s('<rect x="5" y="5" width="8.5" height="8.5" rx="1.5"/><path d="M11 5V3.5A1 1 0 0 0 10 2.5H3.5a1 1 0 0 0-1 1V10a1 1 0 0 0 1 1H5"/>'),
  curve: s('<path d="M2 13.5C7 13.5 9 2.5 14 2.5"/><circle cx="2" cy="13.5" r="1" fill="currentColor"/><circle cx="14" cy="2.5" r="1" fill="currentColor"/>'),
  film: s('<rect x="2" y="2.5" width="12" height="11" rx="1.5"/><path d="M5 2.5v11M11 2.5v11M2 6h3M2 10h3M11 6h3M11 10h3"/>'),
  frame: s('<path d="M2 5.5V2h3.5M10.5 2H14v3.5M14 10.5V14h-3.5M5.5 14H2v-3.5"/>'),
  send: s('<path d="M8 13V3M3.5 7.5 8 3l4.5 4.5"/>'),
  help: s('<circle cx="8" cy="8" r="6.5"/><path d="M6.2 6.2a1.9 1.9 0 1 1 2.6 1.8c-.5.2-.8.6-.8 1.1v.4"/><circle cx="8" cy="11.6" r=".4" fill="currentColor"/>'),
  close: s('<path d="M4 4l8 8M12 4l-8 8"/>'),
  target: s('<circle cx="8" cy="8" r="5.5"/><circle cx="8" cy="8" r="1.5"/>'),
  undo: s('<path d="M5.5 6.5H11a3 3 0 0 1 0 6H7"/><path d="M7.5 4 5 6.5 7.5 9"/>'),
  redo: s('<path d="M10.5 6.5H5a3 3 0 0 0 0 6h4"/><path d="M8.5 4 11 6.5 8.5 9"/>'),
  sliders: s('<path d="M3 4h10M3 8h10M3 12h10"/><circle cx="6" cy="4" r="1.5" fill="var(--cc-surface-solid)"/><circle cx="10" cy="8" r="1.5" fill="var(--cc-surface-solid)"/><circle cx="5" cy="12" r="1.5" fill="var(--cc-surface-solid)"/>'),
  folder: s('<path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h3l1.5 1.5h4.5A1.5 1.5 0 0 1 14 6v5.5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5z"/>'),
  loop: s('<path d="M3 7V6a2 2 0 0 1 2-2h7.5M10.5 2l2 2-2 2M13 9v1a2 2 0 0 1-2 2H3.5M5.5 14l-2-2 2-2"/>'),
};
