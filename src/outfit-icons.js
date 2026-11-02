// Little pictures of the characters for the outfit tabs and the character picker: Mario in an
// outfit's colours, the others as they look. Drawn here, not taken from the disc.

// Mario's colours on the North American disc, for regions an outfit leaves as they are.
const MARIO = {
  hat: '#d51c18', emblem: '#eee2de', emblemLetter: '#de0008', hair: '#622020', mustache: '#080808', skin: '#ffaa83',
  eyes: '#3a4ec8', shirt: '#eb1d18', overalls: '#0840ac', buttons: '#f6ec05', alohaShirt: '#83faff',
};
const svg = body => `<svg class="outfit-icon-art" viewBox="0 0 40 40" aria-hidden="true">${body}</svg>`;

function mario(look) {
  const c = id => look?.colors?.[id] || MARIO[id];
  const aloha = look?.aloha ? `<path d="M9 40Q9 30 16 28.5L18 40ZM31 40Q31 30 24 28.5L22 40Z" fill="${c('alohaShirt')}"/>` : '';
  const eyes = look?.sunglasses
    ? '<rect x="13.2" y="16.2" width="5.6" height="3.6" rx="1.4" fill="#3c4fd8"/><rect x="21.2" y="16.2" width="5.6" height="3.6" rx="1.4" fill="#3c4fd8"/>'
    : `<ellipse cx="17" cy="17.4" rx="1.3" ry="1.9" fill="${c('eyes')}"/><ellipse cx="23" cy="17.4" rx="1.3" ry="1.9" fill="${c('eyes')}"/>`;
  return svg(`<path d="M5 40Q5 28.5 20 27.5Q35 28.5 35 40Z" fill="${c('shirt')}"/>${aloha}
    <path d="M12.5 40L13.5 31H26.5L27.5 40Z" fill="${c('overalls')}"/>
    <path d="M13.8 31.5L11.5 27.8M26.2 31.5L28.5 27.8" stroke="${c('overalls')}" stroke-width="2.6" stroke-linecap="round"/>
    <circle cx="16" cy="32.6" r="1.5" fill="${c('buttons')}"/><circle cx="24" cy="32.6" r="1.5" fill="${c('buttons')}"/>
    <circle cx="20" cy="18.5" r="8.2" fill="${c('skin')}"/>
    <path d="M11.8 17Q11 21 13 22.5M28.2 17Q29 21 27 22.5" stroke="${c('hair')}" stroke-width="2" fill="none" stroke-linecap="round"/>${eyes}
    <path d="M14.5 22.6Q17 20.6 20 21.8Q23 20.6 25.5 22.6Q23 24.4 20 23.3Q17 24.4 14.5 22.6Z" fill="${c('mustache')}"/>
    <circle cx="20" cy="20.6" r="2.3" fill="${c('skin')}" stroke="#0002" stroke-width=".6"/>
    <path d="M10.5 15.2Q10.5 5.6 20 5.6Q29.5 5.6 29.5 15.2Z" fill="${c('hat')}"/>
    <path d="M8.6 15.6Q20 12.6 31.4 15.6Q20 17.6 8.6 15.6Z" fill="${c('hat')}" stroke="#0002" stroke-width=".6"/>
    <circle cx="20" cy="10.4" r="3" fill="${c('emblem')}"/>`);
}

// Mario's shape in other colours: Luigi, and the see-through impostors.
function plumber(hat, overalls, letter, { skin = '#ffaa83', eyes = '#3a4ec8', mustache = '#2b1a12', ghost = false } = {}) {
  return svg(`<g opacity="${ghost ? 0.85 : 1}"><path d="M5 40Q5 28.5 20 27.5Q35 28.5 35 40Z" fill="${hat}"/><path d="M12.5 40L13.5 31H26.5L27.5 40Z" fill="${overalls}"/>
    <circle cx="20" cy="18.5" r="8.2" fill="${skin}"/><path d="M14.5 22.6Q17 20.6 20 21.8Q23 20.6 25.5 22.6Q23 24.4 20 23.3Q17 24.4 14.5 22.6Z" fill="${mustache}"/>
    <ellipse cx="17" cy="17.4" rx="1.3" ry="1.9" fill="${eyes}"/><ellipse cx="23" cy="17.4" rx="1.3" ry="1.9" fill="${eyes}"/>
    <path d="M10.5 15.2Q10.5 5.6 20 5.6Q29.5 5.6 29.5 15.2Z" fill="${hat}"/><path d="M8.6 15.6Q20 12.6 31.4 15.6Q20 17.6 8.6 15.6Z" fill="${hat}"/>
    ${letter ? `<circle cx="20" cy="10.4" r="3" fill="#fff"/><text x="20" y="12" font-size="4.6" font-weight="900" text-anchor="middle" fill="${hat}" font-family="sans-serif">${letter}</text>` : ''}</g>`);
}

function toad(spots, vest) {
  return svg(`<path d="M8 40Q8 29 20 28.5Q32 29 32 40Z" fill="${vest}"/><circle cx="20" cy="22" r="6.6" fill="#fbd7bf"/>
    <ellipse cx="17.6" cy="21.6" rx="1" ry="1.8" fill="#222"/><ellipse cx="22.4" cy="21.6" rx="1" ry="1.8" fill="#222"/>
    <path d="M4.5 18Q4 5 20 4.5Q36 5 35.5 18Q20 21 4.5 18Z" fill="#fff" stroke="#0001"/><circle cx="20" cy="10" r="3.6" fill="${spots}"/>
    <circle cx="9.5" cy="13.5" r="2.6" fill="${spots}"/><circle cx="30.5" cy="13.5" r="2.6" fill="${spots}"/>`);
}

// A round badge with the first letter, for a character without a picture of its own.
function letter(name, background, color = '#fff') {
  return svg(`<circle cx="20" cy="20" r="17" fill="${background}"/><text x="20" y="26.5" font-size="17" font-weight="800" text-anchor="middle" fill="${color}" font-family="sans-serif">${(name || '?')[0].toUpperCase()}</text>`);
}

const PICTURES = {
  luigi: () => plumber('#2b9a3e', '#2a46a8', 'L'),
  'shadow-mario': () => plumber('#1d3a8a', '#13286a', '', { skin: '#2a54b8', eyes: '#ff9a3c', mustache: '#0b2c6b', ghost: true }),
  'shadow-luigi': () => plumber('#1d5a5a', '#13286a', '', { skin: '#2a7ab8', eyes: '#ff9a3c', mustache: '#0b2c6b', ghost: true }),
  'princess-peach': () => svg(`<path d="M4 40Q6 27 20 27Q34 27 36 40Z" fill="#f48fb8"/><path d="M10 26Q8 14 12 9Q20 3 28 9Q32 14 30 26Q26 20 20 20Q14 20 10 26Z" fill="#f6d04d"/>
    <circle cx="20" cy="17.5" r="7.2" fill="#fbd7bf"/><ellipse cx="17.3" cy="17" rx="1.1" ry="1.7" fill="#2a6bd0"/><ellipse cx="22.7" cy="17" rx="1.1" ry="1.7" fill="#2a6bd0"/>
    <path d="M17.6 21.2Q20 22.6 22.4 21.2" stroke="#d2507a" stroke-width="1" fill="none"/><path d="M14.5 9.5L15.5 4.5L18 7.5L20 3.5L22 7.5L24.5 4.5L25.5 9.5Z" fill="#f2c230"/><circle cx="20" cy="7.6" r="1" fill="#e2405a"/>`),
  'sunshine-toad': () => toad('#e2312a', '#2f6fd6'),
  toadsworth: () => toad('#a2683a', '#6a3f86'),
  'bowser-jr': () => svg(`<path d="M6 40Q7 28 20 28Q33 28 34 40Z" fill="#f2e3a0"/><path d="M8 26Q6 12 20 10Q34 12 32 26Q20 30 8 26Z" fill="#58b84a"/>
    <path d="M14 11Q15 3 20 6Q24 2 26 11Z" fill="#f2692a"/><path d="M9 24Q20 31 31 24L30 28Q20 33 10 28Z" fill="#fff"/>
    <path d="M11 25L13 27M16 26.5L17 28.5M23 26.5L22 28.5M28 25L26 27" stroke="#d33" stroke-width="1.2"/>
    <ellipse cx="16" cy="18" rx="1.6" ry="2.2" fill="#222"/><ellipse cx="24" cy="18" rx="1.6" ry="2.2" fill="#222"/>`),
  'rivet-cap': name => letter(name, '#f2a531', '#5a3a12'),
  roxxy: name => letter(name, '#c06ad8'),
  'il-piantissimo': name => letter(name, '#4fb8e8'),
};

// The picture of character `id` (named `name`), Mario in `look`.
export function characterIcon(id, name, look) {
  if (id === 'mario') return mario(look);
  return (PICTURES[id] || (n => letter(n, '#8fb3b9')))(name);
}
