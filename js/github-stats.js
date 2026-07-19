const API = 'https://api.github.com';
const CRATES_API = 'https://crates.io/api/v1/crates/voca_rs';
const ACCOUNTS = ['a-merezhanyi', 'jlogicsoftware', 'jZenDev', 'jschoolpl', 'jlogicgames'];
const EVENTS_ACCOUNT = 'a-merezhanyi';
// The real GitHub contribution calendar (same data github.com/a-merezhanyi
// renders on the profile page) — CORS-open, no auth needed.
const CONTRIBUTIONS_API = 'https://github-contributions-api.jogruber.de/v4/a-merezhanyi?y=last';
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const EVENT_LABELS = {
  PushEvent: { label: 'push', tone: 'primary' },
  PullRequestEvent: { label: 'PR', tone: 'accent' },
  PullRequestReviewEvent: { label: 'review', tone: 'accent' },
  CreateEvent: { label: 'create', tone: 'primary' },
  DeleteEvent: { label: 'delete', tone: 'accent' },
  IssuesEvent: { label: 'issue', tone: 'accent' },
  IssueCommentEvent: { label: 'comment', tone: 'accent' },
  ForkEvent: { label: 'fork', tone: 'primary' },
  WatchEvent: { label: 'star', tone: 'primary' },
  ReleaseEvent: { label: 'release', tone: 'primary' },
  MemberEvent: { label: 'member', tone: 'accent' },
};

const getJSON = async (url) => {
  const res = await fetch(url, { headers: { Accept: 'application/vnd.github+json' } });
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  return res.json();
};

const setText = (id, value) => {
  document.getElementById(id)?.replaceChildren(document.createTextNode(value));
};

const formatCompact = (n) => (n >= 1_000 ? `${Math.floor(n / 1000)}k+` : `${n}`);

const relativeTime = (iso) => {
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.round(diffMs / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.round(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.round(months / 12)}y ago`;
};

const commitRow = (c) => {
  const sha = c.sha.slice(0, 7);
  const msg = c.commit.message.split('\n')[0];
  const date = c.commit.author.date.slice(0, 7);
  return `<li>
    <svg class="icon icon--xs"><use href="/assets/icons.svg#icon-git-commit"></use></svg>
    <span class="showcase-card__commit-hash">${sha}</span>
    <span class="showcase-card__commit-msg">${msg}</span>
    <span class="showcase-card__commit-time">${date}</span>
  </li>`;
};

// Real per-event detail pulled straight from the payload GitHub already sent
// us — no extra requests, no fabrication. Falls back to nothing for event
// types that carry no useful extra field.
const eventDetail = (e) => {
  const p = e.payload ?? {};
  switch (e.type) {
    case 'PushEvent': {
      const branch = p.ref?.replace('refs/heads/', '') ?? '';
      const sha = p.head?.slice(0, 7);
      return sha ? `${branch} @ ${sha}` : branch;
    }
    case 'CreateEvent':
    case 'DeleteEvent':
      return [p.ref_type, p.ref].filter(Boolean).join(' ');
    case 'PullRequestEvent':
      return `#${p.pull_request?.number ?? p.number ?? ''} ${p.action ?? ''}`.trim();
    case 'PullRequestReviewEvent':
      return `${p.review?.state ?? ''} on PR #${p.pull_request?.number ?? ''}`.trim();
    case 'IssuesEvent':
      return `#${p.issue?.number ?? ''} ${p.action ?? ''}`.trim();
    case 'IssueCommentEvent':
      return `on #${p.issue?.number ?? ''}`;
    case 'MemberEvent':
      return `${p.action ?? ''} ${p.member?.login ?? ''}`.trim();
    case 'ForkEvent':
      return p.forkee?.full_name ? `→ ${p.forkee.full_name}` : '';
    case 'ReleaseEvent':
      return p.release?.tag_name ?? '';
    default:
      return '';
  }
};

const activityRow = (e) => {
  const meta = EVENT_LABELS[e.type] ?? { label: e.type.replace('Event', '').toLowerCase(), tone: 'primary' };
  const toneClass = meta.tone === 'accent' ? ' is-accent' : '';
  const detail = eventDetail(e);
  return `<li>
    <span class="activity-feed__type${toneClass}">${meta.label}</span>
    <span class="activity-feed__main">
      <span class="activity-feed__repo">${e.repo.name}</span>
      ${detail ? `<span class="activity-feed__detail">${detail}</span>` : ''}
    </span>
    <span class="activity-feed__time">${relativeTime(e.created_at)}</span>
  </li>`;
};

const fetchContributions = async () => {
  const data = await getJSON(CONTRIBUTIONS_API);
  return data.contributions ?? [];
};

const GRID_CELL_PX = 20; // cell width + gap, keep in sync with showcase.css
const GRID_COLUMN_GAP_PX = 8; // .activity-grid-calendar column-gap, keep in sync
const GRID_MIN_WEEKS = 8;

// Renders the actual GitHub contribution calendar — same per-day counts and
// levels github.com/a-merezhanyi shows on the profile page — with month and
// day-of-week labels, matching GitHub's own layout. Measures the real space
// available for it and shows exactly as many recent weeks as fit, so the
// card never needs a horizontal scrollbar.
const renderActivityGrid = (contributions) => {
  const wrap = document.querySelector('.activity-grid-wrap');
  const grid = document.getElementById('activity-grid');
  const dayLabels = document.querySelector('.activity-grid-daylabels');
  const monthsRow = document.getElementById('activity-grid-months');
  const note = document.querySelector('.activity-grid__note');
  if (!wrap || !grid || !contributions.length) return;

  const availableWidth = wrap.getBoundingClientRect().width;
  const dayLabelsWidth = dayLabels?.getBoundingClientRect().width ?? 0;
  const gridAvailable = availableWidth - dayLabelsWidth - GRID_COLUMN_GAP_PX;
  const maxWeeks = Math.max(GRID_MIN_WEEKS, Math.floor(gridAvailable / GRID_CELL_PX));
  const maxDays = maxWeeks * 7;

  // Slice to the most recent maxDays, snapped back to a Sunday boundary so
  // week columns stay aligned — the source array itself already starts on
  // a Sunday, so any multiple-of-7 offset from its start is also a Sunday.
  let sliceStart = Math.max(0, contributions.length - maxDays);
  sliceStart -= sliceStart % 7;
  const shown = contributions.slice(sliceStart);

  const weeks = [];
  for (let i = 0; i < shown.length; i += 7) weeks.push(shown.slice(i, i + 7));

  grid.innerHTML = weeks
    .map((week) => `<div class="activity-grid__week">${week
      .map((d) => `<div class="activity-grid__cell" data-level="${d.level}" title="${d.count} contribution${d.count === 1 ? '' : 's'} on ${d.date}"></div>`)
      .join('')}</div>`)
    .join('');

  if (monthsRow) {
    let lastMonth = null;
    const candidates = [];
    weeks.forEach((week, i) => {
      const month = new Date(week[0].date).getMonth();
      if (month === lastMonth) return;
      lastMonth = month;
      candidates.push({ month, weekIndex: i });
    });

    // A 3-letter label needs ~2 week-columns of room; when two month
    // boundaries land closer than that (e.g. "Apr" then "May" a week
    // later), drop the earlier one rather than let them collide.
    const MIN_GAP_WEEKS = 2;
    const kept = [];
    for (const c of candidates) {
      if (kept.length && c.weekIndex - kept.at(-1).weekIndex < MIN_GAP_WEEKS) kept.pop();
      kept.push(c);
    }

    monthsRow.innerHTML = kept
      .map((c) => `<span class="activity-grid-months__cell" style="left:${c.weekIndex * GRID_CELL_PX}px">${MONTH_NAMES[c.month]}</span>`)
      .join('');
  }

  const total = shown.reduce((sum, d) => sum + d.count, 0);
  if (note) note.textContent = `${total.toLocaleString()} real contributions, last ${shown.length} days`;
};

const updateVocaRs = async () => {
  try {
    const repo = await getJSON(`${API}/repos/a-merezhanyi/voca_rs`);
    setText('voca-stars', repo.stargazers_count);
    setText('voca-forks', repo.forks_count);
    setText('trust-voca-stars', `${repo.stargazers_count}+`);
  } catch {
    // leave the baked-in fallback numbers in place
  }

  try {
    const commits = await getJSON(`${API}/repos/a-merezhanyi/voca_rs/commits?per_page=5`);
    const list = document.getElementById('voca-commits');
    if (list) list.innerHTML = commits.map(commitRow).join('');
  } catch {
    // leave the baked-in fallback commits in place
  }

  try {
    const res = await fetch(CRATES_API);
    if (!res.ok) throw new Error(`crates.io -> ${res.status}`);
    const { crate } = await res.json();
    setText('voca-downloads', formatCompact(crate.downloads));
  } catch {
    // leave the baked-in fallback download count in place
  }
};

const updateAggregateStats = async () => {
  // Require every account to resolve — a partial failure would silently
  // undercount, and a total failure must leave the baked-in fallback numbers
  // in place rather than overwrite them with zeroes.
  try {
    const repoLists = await Promise.all(
      ACCOUNTS.map((account) => getJSON(`${API}/users/${account}/repos?per_page=100`))
    );
    const repos = repoLists.flat();
    const stars = repos.reduce((sum, r) => sum + r.stargazers_count, 0);
    const forks = repos.reduce((sum, r) => sum + r.forks_count, 0);
    setText('stat-total-stars', stars);
    setText('stat-total-forks', forks);
    setText('stat-total-repos', repos.length);
  } catch {
    // leave the baked-in fallback numbers in place
  }
};

const updateActivityList = async () => {
  const status = document.getElementById('activity-feed-status');
  const list = document.getElementById('activity-feed-list');
  try {
    const events = await getJSON(`${API}/users/${EVENTS_ACCOUNT}/events/public?per_page=100`);
    if (status) status.textContent = 'Live · updated just now';
    if (!list) return;
    list.innerHTML = events.length
      ? events.slice(0, 8).map(activityRow).join('')
      : '<li class="activity-feed__empty">No recent public activity.</li>';
  } catch {
    if (status) status.textContent = 'Live fetch unavailable';
    if (list) list.innerHTML = '<li class="activity-feed__empty">Could not reach the GitHub API right now — try again later.</li>';
  }
};

const updateActivityGrid = async () => {
  try {
    const contributions = await fetchContributions();
    if (contributions.length) renderActivityGrid(contributions);
  } catch {
    // leave the placeholder note text in place
  }
};

// Trims trailing rows from the activity list so it doesn't run noticeably
// longer than the calendar next to it — the grid is always exactly 7 rows
// tall, but the list's row height varies with viewport (stacked on mobile,
// single-line on desktop), so this is measured live rather than guessed.
const MIN_ACTIVITY_ROWS = 3;
const syncActivityHeight = () => {
  // Only relevant once the grid and list sit side by side (≥1024px, see
  // showcase.css) — stacked on mobile, so there's no height to match there.
  if (!window.matchMedia('(min-width: 1024px)').matches) return;

  const column = document.querySelector('.activity-grid-column');
  const list = document.getElementById('activity-feed-list');
  if (!column || !list) return;

  const targetHeight = column.getBoundingClientRect().height;
  const items = [...list.children].filter((li) => !li.classList.contains('activity-feed__empty'));
  while (items.length > MIN_ACTIVITY_ROWS && list.getBoundingClientRect().height > targetHeight) {
    items.pop().remove();
  }
};

await Promise.all([updateVocaRs(), updateAggregateStats(), updateActivityList(), updateActivityGrid()]);
syncActivityHeight();
