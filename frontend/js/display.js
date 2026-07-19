// display.js — TV display screen: promo slideshow + ready-orders board.
// Depends on: config.js (API_BASE).
//
// Auth model: display page requires a valid Bearer token (any role).
// Token is kept in localStorage['display_token'] so the TV survives
// power cycles without needing to log back in. A 401 from any of the
// /api/display/* endpoints clears the token and shows the login gate.

const TOKEN_KEY = 'display_token';

// ─── DOM refs (populated in init after DOM parse) ──────────────────

let loginGate, loginForm, loginUserEl, loginPinEl, loginErrorEl;
let container, promoImg, promoFallback, youtubeFrame;
let heroOrders, compactOrders, noOrders, alsoReadyDivider;

// ─── State ─────────────────────────────────────────────────────────

let slides = [];
let currentSlide = 0;
let fallbackVideoUrl = '';
let displayMode = 'slides'; // 'slides' or 'youtube'
// Poll timers — kept as ids so init() can be called again after login
// without spinning up duplicate intervals.
let ordersTimer = null;
let slidesTimer = null;
let slideshowTimer = null;

// ─── Auth helpers ──────────────────────────────────────────────────

function getToken() {
  return localStorage.getItem(TOKEN_KEY);
}
function setToken(t) {
  localStorage.setItem(TOKEN_KEY, t);
}
function clearToken() {
  localStorage.removeItem(TOKEN_KEY);
}

function authHeaders() {
  const t = getToken();
  return t ? { Authorization: `Bearer ${t}` } : {};
}

async function authedFetch(path) {
  const res = await fetch(`${API_BASE}${path}`, { headers: authHeaders() });
  if (res.status === 401) {
    // Token expired or revoked — bounce back to login.
    handleAuthLoss();
    throw new Error('Unauthorized');
  }
  return res;
}

function handleAuthLoss() {
  clearToken();
  stopPolling();
  showLogin();
}

// ─── Login gate ────────────────────────────────────────────────────

function showLogin() {
  if (container) container.style.display = 'none';
  loginGate.style.display = '';
  if (loginUserEl) loginUserEl.focus();
}

function showDisplay() {
  loginGate.style.display = 'none';
  container.style.display = '';
}

async function attemptLogin(userId, pin) {
  const res = await fetch(`${API_BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId, pin }),
  });
  if (!res.ok) throw new Error('Invalid credentials');
  const data = await res.json();
  if (!data.token) throw new Error('No token in response');
  // Any role accepted (both Cashier and Admin can start the display).
  return data.token;
}

// ─── Orders polling ────────────────────────────────────────────────

async function fetchDisplayOrders() {
  try {
    const res = await authedFetch('/api/display/orders');
    if (!res.ok) return;
    const data = await res.json();
    renderOrders(data.orders || []);
  } catch (e) {
    if (e && e.message !== 'Unauthorized') {
      console.error('Display orders fetch failed:', e);
    }
  }
}

function renderOrders(orders) {
  if (!orders.length) {
    heroOrders.innerHTML = '';
    compactOrders.innerHTML = '';
    alsoReadyDivider.style.display = 'none';
    noOrders.style.display = '';
    return;
  }
  noOrders.style.display = 'none';

  const heroes  = orders.slice(0, 3);
  const compact = orders.slice(3, 13);

  heroOrders.innerHTML = heroes.map(o =>
    `<div class="display-hero-card">${escapeHtml(o.customerName || 'Guest')}</div>`
  ).join('');

  compactOrders.innerHTML = compact.map(o =>
    `<div class="display-compact-item">${escapeHtml(o.customerName || 'Guest')}</div>`
  ).join('');

  // Divider only makes sense when there are compact rows below the heroes.
  alsoReadyDivider.style.display = compact.length ? '' : 'none';
}

// ─── Slideshow ─────────────────────────────────────────────────────

async function fetchSlides() {
  try {
    const res = await authedFetch('/api/display/slides');
    if (!res.ok) return;
    const data = await res.json();
    const next = data.slides || [];
    fallbackVideoUrl = data.fallbackVideoUrl || '';
    displayMode = data.displayMode || 'slides';

    // Admin chose YouTube mode — always show YouTube regardless of slides
    if (displayMode === 'youtube') {
      slides = [];
      promoImg.removeAttribute('src');
      showYouTubeFallback();
      return;
    }

    // Slides mode — show uploaded slides, fallback to branding if none
    hideYouTubeFallback();

    const prevIds = slides.map(s => s.slideId).join(',');
    const nextIds = next.map(s => s.slideId).join(',');
    if (prevIds !== nextIds) {
      slides = next;
      if (slides.length) {
        currentSlide = 0;
        showSlide(0);
      } else {
        promoImg.removeAttribute('src');
      }
    }
  } catch (e) {
    if (e && e.message !== 'Unauthorized') {
      console.error('Display slides fetch failed:', e);
    }
  }
}

// ─── YouTube Fallback ──────────────────────────────────────────────

function extractYouTubeVideoId(url) {
  if (!url) return null;
  // Handle youtu.be/VIDEO_ID
  let match = url.match(/youtu\.be\/([A-Za-z0-9_-]{11})/);
  if (match) return match[1];
  // Handle youtube.com/watch?v=VIDEO_ID
  match = url.match(/[?&]v=([A-Za-z0-9_-]{11})/);
  if (match) return match[1];
  // Handle youtube.com/embed/VIDEO_ID
  match = url.match(/\/embed\/([A-Za-z0-9_-]{11})/);
  if (match) return match[1];
  return null;
}

function showYouTubeFallback() {
  const videoId = extractYouTubeVideoId(fallbackVideoUrl);
  if (!videoId || !youtubeFrame) return;
  const embedUrl = `https://www.youtube.com/embed/${videoId}?autoplay=1&mute=1&loop=1&playlist=${videoId}`;
  // Only set src if it changed to avoid reloading the same video
  if (youtubeFrame.src !== embedUrl) {
    youtubeFrame.src = embedUrl;
  }
  youtubeFrame.style.display = '';
  promoFallback.style.display = 'none';
}

function hideYouTubeFallback() {
  if (!youtubeFrame) return;
  youtubeFrame.style.display = 'none';
  youtubeFrame.src = '';
  promoFallback.style.display = '';
}

function showSlide(index) {
  if (!slides.length) return;
  currentSlide = ((index % slides.length) + slides.length) % slides.length;
  const slide = slides[currentSlide];
  // Crossfade: fade current image out, swap src on the transitionend-ish
  // 1s timer (matches the 1s transition in display.css), fade back in.
  promoImg.classList.add('fade-out');
  setTimeout(() => {
    promoImg.src = slide.imageUrl;
    promoImg.alt = slide.title || '';
    promoImg.classList.remove('fade-out');
  }, 1000);
}

function nextSlide() {
  if (slides.length > 1) showSlide(currentSlide + 1);
}

// ─── Polling lifecycle ─────────────────────────────────────────────

function startPolling() {
  stopPolling();
  // Prime immediately, then on the interval.
  fetchDisplayOrders();
  fetchSlides();
  ordersTimer    = setInterval(fetchDisplayOrders, 5000);     // 5s
  slideshowTimer = setInterval(nextSlide,          10000);    // 10s
  slidesTimer    = setInterval(fetchSlides,        1800000);  // 30min
}

function stopPolling() {
  if (ordersTimer)    { clearInterval(ordersTimer);    ordersTimer = null; }
  if (slidesTimer)    { clearInterval(slidesTimer);    slidesTimer = null; }
  if (slideshowTimer) { clearInterval(slideshowTimer); slideshowTimer = null; }
}

// ─── Helpers ───────────────────────────────────────────────────────

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ─── Init ──────────────────────────────────────────────────────────

function init() {
  loginGate      = document.getElementById('displayLogin');
  loginForm      = document.getElementById('displayLoginForm');
  loginUserEl    = document.getElementById('displayLoginUser');
  loginPinEl     = document.getElementById('displayLoginPin');
  loginErrorEl   = document.getElementById('displayLoginError');
  container      = document.getElementById('displayContainer');
  promoImg       = document.getElementById('promoImg');
  promoFallback  = document.getElementById('promoFallback');
  youtubeFrame   = document.getElementById('youtubeFrame');
  heroOrders     = document.getElementById('heroOrders');
  compactOrders  = document.getElementById('compactOrders');
  noOrders       = document.getElementById('noOrders');
  alsoReadyDivider = document.getElementById('alsoReadyDivider');

  loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    loginErrorEl.textContent = '';
    const btn = loginForm.querySelector('button');
    btn.disabled = true;
    btn.textContent = 'Signing in...';
    try {
      const token = await attemptLogin(loginUserEl.value.trim(), loginPinEl.value);
      setToken(token);
      loginPinEl.value = '';
      showDisplay();
      startPolling();
    } catch (err) {
      loginErrorEl.textContent = 'Invalid name or PIN.';
    } finally {
      btn.disabled = false;
      btn.textContent = 'Start Display';
    }
  });

  if (getToken()) {
    showDisplay();
    startPolling();
  } else {
    showLogin();
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
