'use strict';
// Keyboard and controller bindings for the game (platform/pad/pad.cpp reads
// them from the file named by SMS_BINDINGS: one `CONTROL = KEY ... PAD_...`
// line per control; its keys replace the control's keys and its PAD_ buttons
// replace its controller buttons; PAD_LB+PAD_LT is two buttons held together;
// mouse buttons, MOUSE_LEFT and so on, count as keys).
// The launcher keeps only the controls a player changed; everything else stays
// the game's default.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SmsBindings = factory();
})(typeof self !== 'undefined' ? self : this, () => {
  const CONTROLS = [
    { id: 'STICK_UP', label: 'Move forward' }, { id: 'STICK_DOWN', label: 'Move back' },
    { id: 'STICK_LEFT', label: 'Move left' }, { id: 'STICK_RIGHT', label: 'Move right' },
    { id: 'HALF_TILT', label: 'Walk (half tilt)' },
    { id: 'A', label: 'A button (jump)' }, { id: 'B', label: 'B button (dive, talk)' },
    { id: 'X', label: 'X button (switch nozzle)' }, { id: 'Y', label: 'Y button (close-up camera)' },
    { id: 'Z', label: 'Z button (map)' }, { id: 'L', label: 'L trigger (ground pound, sidestep)' },
    { id: 'R', label: 'R trigger (spray FLUDD)' }, { id: 'START', label: 'Start (pause)' },
    { id: 'CSTICK_UP', label: 'Camera up' }, { id: 'CSTICK_DOWN', label: 'Camera down' },
    { id: 'CSTICK_LEFT', label: 'Camera left' }, { id: 'CSTICK_RIGHT', label: 'Camera right' },
    { id: 'DPAD_UP', label: 'D-pad up' }, { id: 'DPAD_DOWN', label: 'D-pad down' },
    { id: 'DPAD_LEFT', label: 'D-pad left' }, { id: 'DPAD_RIGHT', label: 'D-pad right' },
    { id: 'QUIT', label: 'Quit the game' },
    { id: 'L_SOFT', label: 'Soft L press' }, { id: 'R_SOFT', label: 'Soft R press (spray on the move)' },
    // The port's save states (platform/savestate in the game), not GameCube buttons.
    { id: 'SAVE_STATE', label: 'Save a state' }, { id: 'LOAD_STATE', label: 'Load the newest state' },
    // The radar's full map (src/radar.cpp in the game), with the Radar setting on.
    { id: 'MAP', label: 'Open the map' },
    // Held with Tilt with the C-stick on: the C-stick's up and down zoom as on the GameCube (CAMERA_ZOOM in pad.cpp).
    { id: 'CAMERA_ZOOM', label: 'Zoom with the C-stick (hold, with Tilt with the C-stick on)' }
  ];
  // The game's built-in defaults (kDefaultBindings in platform/pad/pad.cpp), laid out for keyboard and mouse
  // with mouse look: WASD moves, left click jumps, right click dives, Q switches the nozzle, E is the close-up
  // camera, middle click sprays FLUDD softly and Space fully, Left Shift is L and Tab the map (Z).
  const DEFAULTS = {
    A: ['MOUSE_LEFT'], B: ['MOUSE_RIGHT'], X: ['Q'], Y: ['E'], Z: ['TAB'], L: ['LSHIFT'], R: ['SPACE'],
    START: ['ENTER'], DPAD_UP: ['1', 'KP_8'], DPAD_DOWN: ['2', 'KP_2'], DPAD_LEFT: ['3', 'KP_4'],
    DPAD_RIGHT: ['4', 'KP_6'], STICK_UP: ['W', 'UP'], STICK_DOWN: ['S', 'DOWN'], STICK_LEFT: ['A', 'LEFT'],
    STICK_RIGHT: ['D', 'RIGHT'], CSTICK_UP: ['I'], CSTICK_DOWN: ['K'], CSTICK_LEFT: ['J'], CSTICK_RIGHT: ['L'],
    HALF_TILT: ['LCTRL'], QUIT: ['ESCAPE'],
    // a light L or R press without the click (L_SOFT / R_SOFT in pad.cpp)
    L_SOFT: [], R_SOFT: ['MOUSE_MIDDLE'],
    SAVE_STATE: ['F5'], LOAD_STATE: ['F6'], MAP: ['M'],
    // no key: the mouse wheel zooms
    CAMERA_ZOOM: []
  };
  // The keyboard-only layout the game had before (Space jumps, Shift dives, Q and E are L and R): what keys a
  // player changed back then were kept against, and the Controls page's Classic keys.
  const CLASSIC = {
    ...DEFAULTS,
    A: ['SPACE', 'X'], B: ['LSHIFT', 'RSHIFT', 'C'], X: ['V'], Y: ['F'], Z: ['Z'], L: ['Q'], R: ['E'], R_SOFT: []
  };
  // KeyboardEvent.code to the key names the game knows (kKeys in pad.cpp).
  const CODES = {
    Enter: 'ENTER', Escape: 'ESCAPE', Backspace: 'BACKSPACE', Tab: 'TAB', Space: 'SPACE', Minus: 'MINUS',
    Equal: 'EQUALS', BracketLeft: 'LBRACKET', BracketRight: 'RBRACKET', Semicolon: 'SEMICOLON',
    Quote: 'APOSTROPHE', Comma: 'COMMA', Period: 'PERIOD', Slash: 'SLASH', F1: 'F1', F2: 'F2', F3: 'F3', F4: 'F4',
    F5: 'F5', F6: 'F6', F7: 'F7', F8: 'F8', F9: 'F9', F10: 'F10', F11: 'F11', F12: 'F12',
    ArrowUp: 'UP', ArrowDown: 'DOWN', ArrowLeft: 'LEFT', ArrowRight: 'RIGHT', NumpadDivide: 'KP_DIVIDE',
    NumpadMultiply: 'KP_MULTIPLY', NumpadSubtract: 'KP_MINUS', NumpadAdd: 'KP_PLUS', NumpadEnter: 'KP_ENTER',
    ControlLeft: 'LCTRL', ShiftLeft: 'LSHIFT', AltLeft: 'LALT', ControlRight: 'RCTRL', ShiftRight: 'RSHIFT',
    AltRight: 'RALT'
  };
  for (const letter of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') CODES[`Key${letter}`] = letter;
  for (let digit = 0; digit <= 9; digit++) { CODES[`Digit${digit}`] = String(digit); CODES[`Numpad${digit}`] = `KP_${digit}`; }
  // Mouse buttons the game reads as keys (kKeys in pad.cpp), in MouseEvent.button order: 0 is the left button,
  // 1 the middle (wheel), 2 the right, 3 and 4 the side buttons.
  const MOUSE_BUTTONS = [
    { id: 'MOUSE_LEFT', label: 'Left click' }, { id: 'MOUSE_MIDDLE', label: 'Middle click' },
    { id: 'MOUSE_RIGHT', label: 'Right click' }, { id: 'MOUSE_BACK', label: 'Mouse back' },
    { id: 'MOUSE_FORWARD', label: 'Mouse forward' }
  ];
  const KEYS = new Set([...Object.values(CODES), ...MOUSE_BUTTONS.map(button => button.id)]);
  const MAX_KEYS = 8;  // kMaxKeys in pad.cpp

  // Controller buttons the game reads (kPadButtons in pad.cpp), named for an Xbox pad, in the order of the
  // browser Gamepad API's standard mapping (navigator.getGamepads(): button 0 is A ... 16 is Guide).
  const PAD_BUTTONS = [
    { id: 'PAD_A', label: 'A' }, { id: 'PAD_B', label: 'B' }, { id: 'PAD_X', label: 'X' }, { id: 'PAD_Y', label: 'Y' },
    { id: 'PAD_LB', label: 'LB' }, { id: 'PAD_RB', label: 'RB' }, { id: 'PAD_LT', label: 'LT' }, { id: 'PAD_RT', label: 'RT' },
    { id: 'PAD_BACK', label: 'Back' }, { id: 'PAD_START', label: 'Start' }, { id: 'PAD_LSTICK', label: 'Left stick press' },
    { id: 'PAD_RSTICK', label: 'Right stick press' }, { id: 'PAD_DPUP', label: 'D-pad up' }, { id: 'PAD_DPDOWN', label: 'D-pad down' },
    { id: 'PAD_DPLEFT', label: 'D-pad left' }, { id: 'PAD_DPRIGHT', label: 'D-pad right' }, { id: 'PAD_GUIDE', label: 'Guide' }
  ];
  const PADS = new Set(PAD_BUTTONS.map(button => button.id));
  const MAX_PADS = 4;  // kMaxPad in pad.cpp
  // The game's built-in controller layout (kDefaultPad in pad.cpp); other controls have no button.
  const PAD_DEFAULTS = {
    A: ['PAD_A'], B: ['PAD_B'], X: ['PAD_X'], Y: ['PAD_Y'], Z: ['PAD_RB'], L: ['PAD_LT'], R: ['PAD_RT'],
    START: ['PAD_START'], DPAD_UP: ['PAD_DPUP'], DPAD_DOWN: ['PAD_DPDOWN'], DPAD_LEFT: ['PAD_DPLEFT'],
    DPAD_RIGHT: ['PAD_DPRIGHT'], SAVE_STATE: ['PAD_LB+PAD_RB'], MAP: ['PAD_BACK'], CAMERA_ZOOM: ['PAD_RSTICK']
  };

  // The controller button for a standard-mapping Gamepad API button index, or null.
  function padFromIndex(index) { return PAD_BUTTONS[index]?.id || null; }
  // The game reads controller buttons by the letters printed on them (A is a Switch controller's right-hand
  // button), but the browser reads them by place (button 0 is the bottom one). True for a controller printed
  // like Nintendo's, by its Gamepad API id: a Switch controller, or any with Nintendo button layout on (the
  // game's SMS_NINTENDO_LAYOUT) but a Steam Deck's own controls.
  function nintendoLetters(id = '', nintendoLayout = false) {
    if (/steam deck/i.test(id)) return false;
    return Boolean(nintendoLayout) || /Vendor: 057e|Nintendo|Joy-Con/i.test(id);
  }
  // A standard-mapping button index by letter: with Nintendo letters, A and B, and X and Y, change places.
  function letterIndex(index, letters) { return letters && index >= 0 && index < 4 ? index ^ 1 : index; }
  // One button ("LB"), or two held together ("LB + LT").
  function padLabel(id) {
    return id.split('+').map(part => PAD_BUTTONS.find(button => button.id === part)?.label || part).join(' + ');
  }
  // A button, or two different buttons held together (FIRST+SECOND), as the game reads them.
  function validPad(item) {
    const parts = item.split('+');
    return parts.length <= 2 && parts.every(part => PADS.has(part)) && new Set(parts).size === parts.length;
  }
  // Two buttons as one binding, in the order they were pressed.
  function padCombo(first, second) { return first === second ? first : `${first}+${second}`; }

  // The key name for a KeyboardEvent.code, or null for a key the game cannot read.
  function keyFromCode(code) { return CODES[code] || null; }
  // The key name for a MouseEvent.button, or null for a button the game cannot read.
  function keyFromMouse(button) { return MOUSE_BUTTONS[button]?.id || null; }
  function isMouse(key) { return MOUSE_BUTTONS.some(button => button.id === key); }
  // How the Controls page shows a key: "LSHIFT", "KP 8", "Left click".
  function keyLabel(key) { return MOUSE_BUTTONS.find(button => button.id === key)?.label || key.replace('_', ' '); }

  // Only the controls that differ from the defaults, each a list of known keys.
  function normalize(input) {
    const result = {};
    if (!input || typeof input !== 'object') return result;
    for (const { id } of CONTROLS) {
      if (!Array.isArray(input[id])) continue;
      const keys = [...new Set(input[id].map(String).filter(key => KEYS.has(key)))].slice(0, MAX_KEYS);
      if (keys.join(' ') !== DEFAULTS[id].join(' ')) result[id] = keys;
    }
    return result;
  }

  function keysFor(bindings, id) { return (bindings && bindings[id]) || DEFAULTS[id]; }

  // Keys a player changed, saved against the classic defaults, as changes from today's: every control they
  // left alone keeps its classic keys, so the layout they played with stays as it was.
  function fromClassic(changed) { return normalize({ ...CLASSIC, ...(changed || {}) }); }

  // Only the controls whose controller buttons differ from the defaults, each a non-empty list of known buttons.
  function normalizePads(input) {
    const result = {};
    if (!input || typeof input !== 'object') return result;
    for (const { id } of CONTROLS) {
      if (!Array.isArray(input[id])) continue;
      const pads = [...new Set(input[id].map(String).filter(validPad))].slice(0, MAX_PADS);
      if (pads.length && pads.join(' ') !== (PAD_DEFAULTS[id] || []).join(' ')) result[id] = pads;
    }
    return result;
  }

  function padsFor(padBindings, id) { return (padBindings && padBindings[id]) || PAD_DEFAULTS[id] || []; }

  // Every control's keys; controller buttons only for the controls changed (the rest keep the game's layout).
  function fileText(bindings, padBindings = {}) {
    const lines = ['# Written by SMS Launcher from Settings → Controls. Changes here are replaced on the next launch.'];
    for (const { id } of CONTROLS) {
      const pads = padBindings && padBindings[id] ? padBindings[id] : [];
      lines.push(`${id} =${[...keysFor(bindings, id), ...pads].map(item => ` ${item}`).join('')}`);
    }
    return `${lines.join('\n')}\n`;
  }

  return { CONTROLS, DEFAULTS, CLASSIC, fromClassic, PAD_BUTTONS, PAD_DEFAULTS, MOUSE_BUTTONS, keyFromCode, keyFromMouse, isMouse, keyLabel,
    normalize, keysFor, fileText,
    padFromIndex, nintendoLetters, letterIndex, padLabel, padCombo, normalizePads, padsFor };
});
