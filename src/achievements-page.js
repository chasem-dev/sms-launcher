'use strict';

// The Achievements page (src/achievements.js): every achievement by stage, the
// player's unlocks, and each new one marked as the game announces it. Opened before
// the icons are downloaded, the tab offers to download just those first.
(() => {
  // Game order; the list's own stages come after any not named here.
  const STAGE_ORDER = ['Tutorial', 'Delfino Airstrip', 'Delfino Plaza', 'Bianco Hills', 'Ricco Harbor', 'Gelato Beach', 'Pinna Park',
    'Sirena Beach', 'Noki Bay', 'Pianta Village', 'Corona Mountain', 'Erto Rock', 'Lighthouse Island', 'Warship Island',
    'Hotel Lacrima', 'Pianta Pit', 'Daisy Cruiser', "Mario's Dream", 'Lancia Fredda Peaks', 'Vaporwave', 'Yoshi Village',
    'Red Lily City', 'Peach Beach', 'Spettro Casino', 'Isle Delfino', "Peach's Castle", 'Anywhere'];
  let state = { supported: false, achievements: [], unlocked: 0, total: 0, iconsNeeded: false, seen: true };
  let icons = {}, iconsLoaded = false, filter = 'all', loadedFor = null;
  const fresh = new Set();

  const date = time => new Date(time * 1000).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });

  function groups() {
    const byStage = new Map();
    for (const item of state.achievements) {
      if (!byStage.has(item.stage)) byStage.set(item.stage, []);
      byStage.get(item.stage).push(item);
    }
    const rank = stage => { const at = STAGE_ORDER.indexOf(stage); return at < 0 ? STAGE_ORDER.length : at; };
    return [...byStage].sort((a, b) => rank(a[0]) - rank(b[0]));
  }

  function card(item) {
    const element = document.createElement('article');
    element.className = `achievement${item.unlockedAt ? '' : ' locked'}${fresh.has(item.id) ? ' fresh' : ''}`;
    element.dataset.id = item.id;
    const icon = icons[item.id] ? document.createElement('img') : document.createElement('span');
    if (icons[item.id]) { icon.src = icons[item.id]; icon.alt = ''; } else icon.className = 'achievement-no-icon';
    const text = document.createElement('div');
    text.className = 'achievement-text';
    const title = document.createElement('strong'); title.textContent = item.title;
    const description = document.createElement('p'); description.textContent = item.description;
    const when = document.createElement('small');
    when.textContent = item.unlockedAt ? `Unlocked ${date(item.unlockedAt)}` : 'Locked';
    text.append(title, description, when);
    element.append(icon, text);
    return element;
  }

  function render() {
    const { achievements, unlocked, total } = state;
    // Eclipse's own list while Eclipse is on.
    $('achievements-game').hidden = !state.eclipse;
    $('achievements-count').textContent = `${unlocked} of ${total} unlocked`;
    $('achievements-percent').textContent = `${total ? Math.floor(unlocked * 100 / total) : 0}%`;
    $('achievements-ring').style.setProperty('--done', total ? String(unlocked / total) : '0');
    const latest = achievements.filter(item => item.unlockedAt).sort((a, b) => b.unlockedAt - a.unlockedAt)[0];
    $('achievements-latest').textContent = latest ? `Latest: ${latest.title}` : 'None unlocked yet';
    // The launcher's own list, for a game from before achievements (or none yet): only the game unlocks them.
    $('achievements-update').hidden = state.counted !== false;
    $('achievements-update-text').textContent = !current?.repoReady ? 'Set up the game on Play to start unlocking these.'
      : current.gameSource && !current.game?.needsUpdate ? 'Your custom game source builds a version from before achievements: choose the default one in Settings to start unlocking these.'
      : 'Your game version came out before achievements: update the game on Play to start unlocking these.';
    for (const button of document.querySelectorAll('[data-achievement-filter]')) {
      const on = button.dataset.achievementFilter === filter;
      button.classList.toggle('active', on);
      button.setAttribute('aria-checked', String(on));
    }

    const container = $('achievement-groups'), stages = $('achievement-stages');
    container.replaceChildren();
    stages.replaceChildren();
    for (const [stage, items] of groups()) {
      const done = items.filter(item => item.unlockedAt).length;
      const shown = items.filter(item => filter === 'all' || (filter === 'unlocked') === Boolean(item.unlockedAt));
      const jump = document.createElement('button');
      jump.className = done === items.length ? 'complete' : '';
      jump.textContent = stage;
      const count = document.createElement('small'); count.textContent = `${done}/${items.length}`;
      jump.append(count);
      jump.disabled = !shown.length;
      stages.append(jump);
      if (!shown.length) continue;
      const group = document.createElement('section');
      group.className = 'achievement-group';
      const head = document.createElement('div');
      head.className = 'achievement-group-head';
      const name = document.createElement('h2'); name.textContent = stage;
      const tally = document.createElement('span'); tally.textContent = `${done} of ${items.length}`;
      const bar = document.createElement('i'), fill = document.createElement('b');
      fill.style.width = `${done * 100 / items.length}%`;
      bar.append(fill);
      head.append(name, tally, bar);
      const grid = document.createElement('div');
      grid.className = 'achievement-grid';
      // Unlocked first, newest first; the rest in the list's order.
      const sorted = [...shown].sort((a, b) => (b.unlockedAt || 0) - (a.unlockedAt || 0) || a.id - b.id);
      grid.append(...sorted.map(card));
      group.append(head, grid);
      container.append(group);
      jump.addEventListener('click', () => group.scrollIntoView({ block: 'start' }));
    }
    const empty = $('achievements-empty');
    empty.hidden = Boolean(container.childElementCount);
    empty.textContent = filter === 'unlocked' ? 'Nothing unlocked yet. Play to earn your first achievement.'
      : 'Every achievement is unlocked. Nice work!';
  }

  const ready = () => state.supported && !state.iconsNeeded;

  async function load() {
    try { state = await window.sms.achievements(); } catch (_) { return; }
    $('nav-achievements').classList.toggle('spotlight', !state.seen);
    $('achievements-new').hidden = state.seen;
    if (!state.supported && page === 'achievements') showPage('play');
    if (state.supported && !iconsLoaded) {
      iconsLoaded = true;
      try { icons = await window.sms.achievementIcons(); } catch (_) { icons = {}; }
    }
    if (page === 'achievements') render();
  }

  $('achievements-update-go').addEventListener('click', () => showPage('play'));
  for (const button of document.querySelectorAll('[data-achievement-filter]')) button.addEventListener('click', () => {
    filter = button.dataset.achievementFilter;
    render();
  });
  // The tab stands out until it is first opened.
  function markSeen() {
    if (state.seen) return;
    state.seen = true;
    $('nav-achievements').classList.remove('spotlight');
    $('achievements-new').hidden = true;
    window.sms.markAchievementsSeen().catch(() => {});
  }

  // Without its icons the page waits: a popup offers to download them, then shows it.
  const dialog = $('achievements-get');
  let busy = false;
  async function offerIcons() {
    await load();
    if (ready()) { showPage('achievements'); return; }
    if (!busy) {
      $('achievements-get-error').hidden = true;
      $('achievements-get-go').textContent = 'Download icons';
      $('achievements-get-cancel').textContent = 'Not now';
    }
    dialog.showModal();
  }
  function progress(percent, detail) {
    const bar = $('achievements-get-progress');
    bar.hidden = false;
    bar.classList.toggle('indeterminate', !Number.isFinite(percent));
    $('achievements-get-bar').style.width = Number.isFinite(percent) ? `${percent}%` : '';
    $('achievements-get-detail').textContent = detail || 'Downloading…';
  }
  async function downloadIcons() {
    const from = page;
    busy = true;
    $('achievements-get-go').disabled = true;
    $('achievements-get-go').textContent = 'Downloading…';
    $('achievements-get-cancel').textContent = 'Hide';
    $('achievements-get-error').hidden = true;
    progress(null, 'Starting…');
    try {
      await window.sms.downloadAchievementIcons();
      busy = false;
      // Hidden and gone to another page meanwhile: the page waits for the tab.
      const show = dialog.open || page === from;
      if (dialog.open) dialog.close();
      await load();
      if (show && ready()) showPage('achievements');
    } catch (error) {
      busy = false;
      $('achievements-get-error').textContent = `${errorText(error).replace(/\.$/, '')}.`;
      $('achievements-get-error').hidden = false;
      $('achievements-get-go').textContent = 'Try again';
      $('achievements-get-cancel').textContent = 'Not now';
      if (!dialog.open) setMessage(errorText(error), true);
    } finally {
      $('achievements-get-go').disabled = false;
      $('achievements-get-progress').hidden = true;
    }
  }
  // Anything unexpected lands in the message bar, not an unhandled rejection.
  const guarded = task => Promise.resolve().then(task).catch(error => { busy = false; setMessage(errorText(error), true); });
  $('achievements-get-go').addEventListener('click', () => guarded(downloadIcons));
  window.sms.onActivity(activity => { if (busy && activity) progress(activity.percent, activity.detail); });

  onPage('achievements', {
    open() {
      markSeen();
      if (ready()) return true;
      guarded(offerIcons);
      return false;
    },
    show: () => { render(); load(); }, hide: () => fresh.clear()
  });

  // The game folder or Eclipse switch decides the list.
  window.smsAchievementsRefresh = data => {
    const key = `${data.config.repo}|${Boolean(data.config.settings.eclipse)}`;
    if (key === loadedFor) return;
    loadedFor = key;
    iconsLoaded = false;
    load();
  };
  // null: the icons were (re)installed.
  window.sms.onAchievement(unlock => {
    if (!unlock) iconsLoaded = false;
    else if (unlock.eclipse === Boolean(state.eclipse)) fresh.add(unlock.id);
    load();
  });
})();
