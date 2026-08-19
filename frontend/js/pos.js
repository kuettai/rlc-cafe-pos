// pos.js — Shell: sidebar, polling, board render, stats
// Part of rlc-cafe-pos v1.52.0 file split
// Depends on: config.js (API_BASE), phone.js, variants.js
// Required by: pos-walkup.js, pos-voucher.js, pos-stock.js,
//              pos-checklist.js, pos-history.js

const $ = s => document.querySelector(s);
const app = $('#app');
let token = sessionStorage.getItem('pos_token');
let currentUser = sessionStorage.getItem('pos_user') || '';
let orders = [];
let prevOrderCount = 0;
// Latest response from /api/pos/shift-summary; refreshed alongside every
// queue poll. Used by renderStats() for completed / revenue numbers.
let shiftSummary = null;
let pollTimer = null;
let viewMode = 'kanban';
let cafeOpen = false;
let celebrationMode = false;
let celebrationPrice = 5;   // flat price for celebration-eligible drinks
let featuredDrink = null;  // { menuItemId, name, basePrice, imageUrl } or null
let searchFilter = '';
let prevUrgentIds = [];
// Which tab the LIST view is showing. Held here rather than read back off the DOM
// so the 7s poll can restore it: renderBoard() used to rebuild the tab strip with
// Pending hardcoded active, so a volunteer on the Ready tab handing over a drink
// was thrown back to Pending within 7 seconds, mid-task.
let listTab = 'PENDING';
// Whether the stats strip is collapsed. Visible by default now, so this only
// records a deliberate collapse and survives the re-render on every poll.
let statsCollapsed = false;

// --- Connection health -------------------------------------------------------
// `lastGoodFetch` is the timestamp of the last SUCCESSFUL queue poll; `fetchFailed`
// says whether the most recent attempt failed. Together they drive the stale
// board treatment.
//
// Why this exists: renderBoard() was reachable only from inside fetchOrders()'s
// try block and the catch only called showError(), which auto-hides after 3s
// against a 7s poll. So a café whose API had gone away rendered an EMPTY board
// under a green OPEN badge — visually identical to "nobody has ordered" — and the
// only warning was on screen 43% of the time. The board must never be able to lie
// about being quiet.
let lastGoodFetch = null;
let fetchFailed = false;
let retryInFlight = false;
function isStale(){ return fetchFailed && lastGoodFetch !== null; }
// True before the first successful poll has ever landed. Distinct from stale:
// there is no "as it was at" time to show, so the copy has to differ.
function isColdFailure(){ return fetchFailed && lastGoodFetch === null; }
function clockStr(d){
  return new Date(d).toLocaleTimeString('en-MY',{hour:'2-digit',minute:'2-digit',second:'2-digit'});
}
// "5m 35s" — how old the board is. Seconds matter under a minute; beyond an hour
// nobody needs the seconds.
function ageStr(since){
  const s = Math.max(0, Math.floor((Date.now() - since)/1000));
  if(s < 60) return `${s}s`;
  const m = Math.floor(s/60), r = s%60;
  if(m < 60) return r ? `${m}m ${r}s` : `${m}m`;
  return `${Math.floor(m/60)}h ${m%60}m`;
}
// Actions are paused while the board is stale: approving against a queue that may
// have moved on is how an order gets approved twice, or the wrong one rejected.
function actionsPaused(){ return fetchFailed; }
function disabledAttr(){ return actionsPaused() ? ' disabled' : ''; }

// --- Auth helpers ---
function authHeaders(){ return { 'Content-Type':'application/json', Authorization:`Bearer ${token}` }; }

async function api(method, path, body){
  const opts = { method, headers: authHeaders() };
  if(body) opts.body = JSON.stringify(body);
  const res = await fetch(`${API_BASE}${path}`, opts);
  if(res.status === 401){ logout(); throw new Error('Unauthorized'); }
  if(!res.ok) throw new Error(await res.text());
  return res.json();
}

function showError(msg){ const b=$('#errorBanner'); b.textContent=msg; b.classList.add('show'); setTimeout(()=>b.classList.remove('show'),3000); }

// --- Pre-orders ---
// A ministry pre-order is placed days ahead (Wed–Sat) and is free (RM0). It
// arrives PENDING and the cashier's approve is the "release to barista" lock,
// which is also what stops the customer editing it further. `isPreOrder` comes
// straight off the DynamoDB record via /api/pos/orders, so an older cached
// shell reading a newer record still gets it. Anything that is not literally
// `true` is treated as a normal order.
function isPreOrder(o){ return !!o && o.isPreOrder === true; }

// Label for the PENDING→PREPARING action. A pre-order has nothing to pay, so
// "Payment Confirmed" / "Approve" would be nonsense to a volunteer.
function approveLabel(o){ return isPreOrder(o) ? 'Release to barista' : '✓ Approve'; }

// Malaysia is UTC+8 with no DST, so shifting the instant by 8h and taking the
// date part of the ISO string gives the MYT calendar date. Returns '' for a
// missing or unparseable value rather than guessing at today.
const MYT_OFFSET_MS = 8 * 60 * 60 * 1000;
function mytDate(value){
  if(!value) return '';
  const t = new Date(value).getTime();
  if(!Number.isFinite(t)) return '';
  return new Date(t + MYT_OFFSET_MS).toISOString().slice(0,10);
}

// "23 Aug" from an ISO instant, via the MYT calendar date so a tablet set to
// another timezone still shows the day the café means. Empty when unparseable.
const MONTHS_SHORT = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
function mytDateShort(value){
  const d = mytDate(value);
  if(!d) return '';
  const parts = d.split('-');
  return `${Number(parts[2])} ${MONTHS_SHORT[Number(parts[1]) - 1] || ''}`.trim();
}

// "Sun 24 Aug" — same MYT calendar date as mytDateShort, plus the weekday, for
// the one place a volunteer has to judge *which service* they are about to
// release: the not-due-today confirmation. Services are Sundays, so the weekday
// is what makes "not today" land; a bare "24 Aug" reads as a number.
// The weekday is read off the already-derived MYT date string at explicit UTC
// midnight, so the tablet's own timezone cannot shift it. No new "today" maths —
// due-today is decided only by releasablePreOrders().
const DAYS_SHORT = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
function mytDateLong(value){
  const d = mytDate(value);
  if(!d) return '';
  const dow = new Date(`${d}T00:00:00Z`).getUTCDay();
  const day = DAYS_SHORT[dow];
  const short = mytDateShort(value);
  return day ? `${day} ${short}` : short;
}

// Pre-orders the bulk release will actually act on: PENDING, and due TODAY.
// A pre-order's `expiresAt` is the ISO service-end time (deliberately a string,
// never a numeric TTL), which is the only per-order signal for which service it
// belongs to. The backend releases only today's, so the count in the confirmation
// dialog has to match — otherwise it promises 6 and the result reports 4. An
// order with no usable expiresAt is left out rather than counted optimistically.
function releasablePreOrders(){
  const today = mytDate(Date.now());
  return orders.filter(o => o.status === 'PENDING' && isPreOrder(o) && mytDate(o.expiresAt) === today);
}

// Is THIS order one the bulk release would have taken? Asked by membership of
// releasablePreOrders() rather than by re-testing expiresAt, so the per-order
// and bulk paths physically cannot disagree about what "today" is. A pre-order
// with a missing or unparseable expiresAt is not a member, so it falls to the
// cautious side and gets confirmed.
function isPreOrderDueToday(id){
  return releasablePreOrders().some(o => (o.orderId||o.id) === id);
}

// --- Login ---
function renderLogin(){
  stopPolling();
  const lastUser = localStorage.getItem('pos_last_user') || '';
  app.innerHTML = `<div class="pos-login">
    <h2>Cashier Login</h2>
    <form id="loginForm">
      <input id="loginUser" placeholder="Your name (e.g. Sarah)" required autocomplete="username" class="pos-input" value="${lastUser}">
      <input id="loginPin" type="password" inputmode="numeric" maxlength="6" placeholder="PIN (6 digits)" required class="pos-input">
      <button type="submit" class="pos-btn pos-btn-primary" style="width:100%">Login</button>
    </form>
    <p style="margin-top:16px;font-size:.8rem;color:var(--text-light)">Shortcuts: W = Walk-up, M = Menu, H = History, / = Search</p>
  </div>`;
  $('#loginForm').onsubmit = async e => {
    e.preventDefault();
    try{
      const res = await fetch(`${API_BASE}/api/auth/login`,{ method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({userId:$('#loginUser').value, pin:$('#loginPin').value}) });
      if(!res.ok) throw new Error();
      const data = await res.json();
      token = data.token;
      currentUser = data.name || $('#loginUser').value;
      sessionStorage.setItem('pos_token', token);
      sessionStorage.setItem('pos_user', currentUser);
      localStorage.setItem('pos_last_user', $('#loginUser').value);
      if(data.forceUpdatePin){ showPinChangeModal(); return; }
      renderMain();
    } catch(e){ showError('Invalid PIN'); }
  };
}

function logout(){ token=null; currentUser=''; sessionStorage.removeItem('pos_token'); sessionStorage.removeItem('pos_user'); renderLogin(); }

function showPinChangeModal(){
  const modal = document.createElement('div');
  modal.className = 'pos-modal-overlay';
  modal.innerHTML = `<div class="pos-modal" style="max-width:400px">
    <h3>🔒 Change Your PIN</h3>
    <p style="margin:12px 0;font-size:.9rem;color:var(--text-light)">You must set a new PIN before continuing.</p>
    <input id="newPin1" type="password" inputmode="numeric" maxlength="6" placeholder="New PIN (min 6 digits)" class="pos-input" style="margin-bottom:10px">
    <input id="newPin2" type="password" inputmode="numeric" maxlength="6" placeholder="Confirm PIN" class="pos-input" style="margin-bottom:16px">
    <button id="pinChangeSubmit" class="pos-btn pos-btn-primary" style="width:100%">Update PIN</button>
  </div>`;
  document.body.appendChild(modal);
  modal.querySelector('#pinChangeSubmit').onclick = async()=>{
    const p1 = modal.querySelector('#newPin1').value, p2 = modal.querySelector('#newPin2').value;
    if(!p1 || p1.length < 6){ showError('PIN must be at least 6 digits'); return; }
    if(p1 !== p2){ showError('PINs do not match'); return; }
    try{
      const res = await fetch(`${API_BASE}/api/auth/update-pin`,{ method:'POST', headers:{'Content-Type':'application/json','Authorization':'Bearer '+token}, body:JSON.stringify({newPin:p1}) });
      if(!res.ok){ const err = await res.json().catch(()=>({})); throw new Error(err.error||'Failed'); }
      modal.remove();
      renderMain();
    } catch(e){ showError(e.message||'Failed to update PIN'); }
  };
}

// --- Main view ---
function renderMain(){
  app.innerHTML = `<aside class="pos-sidebar" id="posSidebar">
  <!-- Name on its own line with the state under it: at 220px a name plus a pill
       wraps into an orphaned word, and this row is read at a glance to confirm who
       is on the till. The state is a WORD as well as a colour — a bare dot is a
       single-channel signal, and this one was the wrong colour anyway (see
       renderStatusDot). -->
  <div class="pos-sidebar-user">👤 ${escapeHtmlPos(currentUser)}
    <span class="pos-status-chip ${cafeOpen?'is-open':'is-closed'}"><span class="pos-status-dot ${cafeOpen?'open':'closed'}"></span><span id="posStatusText">${cafeOpen?'OPEN':'CLOSED'}</span></span>
  </div>
  <div class="pos-sidebar-section-label">Quick Actions</div>
  <div class="pos-sidebar-actions">
    <button id="btnVoucher" class="pos-action-btn pos-action-primary">🎟️ Voucher</button>
    <button id="btnCelebration" class="pos-action-btn pos-action-toggle ${celebrationMode?'active':''}" aria-pressed="${celebrationMode?'true':'false'}">${celebrationMode?'🎉 Celebration: ON':'🎉 Celebration: OFF'}</button>
    <button id="btnCafeToggle" class="pos-action-btn ${cafeOpen?'pos-action-cafe-open':'pos-action-cafe-closed'}">${cafeOpen?'☕ Close Café':'☕ Open Café'}</button>
    <button id="btnHandover" class="pos-action-btn" style="${cafeOpen ? '' : 'display:none'}">🔄 Handover</button>
  </div>
  <div class="pos-sidebar-section-label">Navigation</div>
  <nav class="pos-sidebar-nav">
    <button id="btnPrep" class="pos-sidebar-btn">☕ Prep Queue</button>
    <button id="btnMenu" class="pos-sidebar-btn">📋 Menu</button>
    <button id="btnChecklist" class="pos-sidebar-btn">☑️ Checklist</button>
    <button id="btnStockCount" class="pos-sidebar-btn">📦 Stock Count</button>
    <button id="btnPlanogram" class="pos-sidebar-btn">📷 AI Scan</button>
    <button id="btnHistory" class="pos-sidebar-btn">📜 History</button>
    <!-- Ingredient usage moved out of the stats strip. It is a REPORT, like History
         and Stats, and as a 44px button inside a strip of ~23px readouts it was
         setting that strip's whole row height — the strip is now on screen
         permanently, so that cost 20px of board on every render. Here it also gets a
         readable label instead of a bare 📦. -->
    <button id="btnIngUsed" class="pos-sidebar-btn">📦 Ingredients Used</button>
    <button id="btnStats" class="pos-sidebar-btn">${statsCollapsed?'📊 Show Stats':'📊 Hide Stats'}</button>
  </nav>
</aside>
<div class="pos-sidebar-overlay" id="posSidebarOverlay"></div>
<main class="pos-main">
  <!-- The closed banner now CARRIES the primary action. It used to read "Tap Open
       to start service" while the only ☀️ Open Café button lived in the sidebar at
       left:-212px — an instruction pointing off-canvas. -->
  <div id="closedBanner" class="pos-closed-banner${cafeOpen?'':' visible'}" role="alert" aria-live="assertive">
    <div class="pos-closed-txt">
      <strong>⚠️ The café is closed — customers cannot order yet</strong>
      <span>Finish the opening checklist, then open the café.</span>
    </div>
    <button id="btnOpenCafeBanner" class="pos-btn-open-cafe">☀️ Open Café</button>
  </div>
  <!-- Persistent connection-lost panel. Empty and hidden until a poll fails;
       filled by renderConnectionState(). Deliberately NOT the 3s-auto-hiding
       #errorBanner: the whole defect was a warning that disappeared while the
       fault continued. -->
  <div id="staleBanner" class="pos-stale-banner" role="alert" aria-live="assertive"></div>
  <div id="celebBanner" class="pos-celeb-banner${celebrationMode?' visible':''}" role="status" aria-live="polite">🎉 CELEBRATION MODE — All eligible drinks discounted</div>
  <div id="posStats" class="pos-stats-bar${statsCollapsed?' collapsed':''}"></div>
  <div class="pos-controls">
    <!-- Walk-up lives here, not in the sidebar. A customer arriving at the
         counter is the most time-critical action a cashier takes, and it used
         to cost three taps: open the hamburger, tap Walk-up, then close the
         hamburger to get the full board back. Kept id="btnWalkup" so the "W"
         shortcut and the training tour still find it. -->
    <button id="btnWalkup" class="pos-btn pos-btn-sm pos-btn-walkup">➕ Walk-up</button>
    <input id="orderSearch" class="pos-input pos-search" placeholder="Search customer...">
    <!-- Bulk release for today's ministry pre-orders. Hidden entirely when there
         are none due today (which is most of the week), so it never sits there
         inviting a tap that would do nothing. renderStats keeps the count fresh
         on every poll. -->
    <button id="btnReleasePreorders" class="pos-btn pos-btn-sm pos-btn-preorder-release" hidden></button>
    <button id="btnFeatured" class="pos-btn pos-btn-sm pos-btn-outline pos-btn-featured${featuredDrink?' pos-btn-featured-active':''}">⭐ ${featuredDrink?escapeHtmlPos(featuredDrink.name):'Set Featured'}</button>
    <button id="btnView" class="pos-btn pos-btn-sm pos-btn-outline">${viewMode==='kanban'?'📋 List':'📊 Kanban'}</button>
    <span id="lastRefresh" class="pos-last-refresh"></span>
  </div>
  <div id="orderBoard" class="pos-board"></div>
</main>`;
  document.getElementById('posHeaderToggle').onclick = () => {
    $('#posSidebar').classList.toggle('open');
  };
  $('#posSidebarOverlay').onclick = () => {
    $('#posSidebar').classList.remove('open');
  };
  $('#btnCafeToggle').onclick = toggleCafe;
  // Same destination as the sidebar toggle, reached from the banner that names it.
  const openBannerBtn = document.getElementById('btnOpenCafeBanner');
  if(openBannerBtn) openBannerBtn.onclick = ()=> openChecklist('open');
  $('#btnCelebration').onclick = async()=>{
    try{
      celebrationMode=!celebrationMode;
      await api('PUT','/api/pos/cafe/celebration',{enabled:celebrationMode});
      renderMain();
    } catch(e){ celebrationMode=!celebrationMode; showError('Failed to toggle celebration'); }
  };
  $('#btnWalkup').onclick = openWalkup;
  $('#btnReleasePreorders').onclick = releaseAllPreorders;
  $('#btnVoucher').onclick = openVoucherFlow;
  $('#btnMenu').onclick = openMenuToggle;
  $('#btnPrep').onclick = openPrepView;
  $('#btnChecklist').onclick = ()=>{
    const phase = cafeOpen ? 'close' : 'open';
    openChecklist(phase);
  };
  const btnHandover = document.getElementById('btnHandover');
  if(btnHandover) btnHandover.onclick = ()=> openChecklist('handover');
  $('#btnPlanogram').onclick = ()=>{
    const modal=document.createElement('div');
    modal.className='pos-modal-overlay';
    modal.innerHTML=`<div class="pos-modal" style="max-width:340px;text-align:center">
      <button class="pos-modal-close">✕</button>
      <h3>📷 AI Stock Scan</h3>
      <p style="font-size:.85rem;color:var(--text-light);margin:8px 0 20px">Which area?</p>
      <div style="display:flex;flex-direction:column;gap:10px">
        <button class="pos-btn pos-btn-primary pos-btn-lg" id="scFridge">🧊 Fridge</button>
        <button class="pos-btn pos-btn-primary pos-btn-lg" id="scStore">📦 Storeroom</button>
      </div>
    </div>`;
    document.body.appendChild(modal);
    modal.querySelector('.pos-modal-close').onclick=()=>modal.remove();
    modal.onclick=e=>{ if(e.target===modal) modal.remove(); };
    modal.querySelector('#scFridge').onclick=()=>{ modal.remove(); openStockCount('fridge'); };
    modal.querySelector('#scStore').onclick=()=>{ modal.remove(); openStockCount('storeroom'); };
  };
  $('#btnStockCount').onclick = ()=> openManualStockCount();
  // Logout is GUARDED. The guarding used to be exactly inverted: Tutorial (which
  // is reversible) sat behind a confirm() while Logout — one tap, ends the shift's
  // session, in the header next to it — had none at all. Uses the same modal
  // pattern as askStaffPrice/confirmReleaseAll rather than window.confirm, which
  // this file already documents as unusable on the counter iPad.
  document.getElementById('headerLogout').onclick = async ()=>{
    const active = orders.filter(o=>o.status==='PENDING'||o.status==='PREPARING').length;
    const ok = await posConfirm({
      title: 'Log out of the till?',
      body: active > 0
        ? `${active} order${active===1?' is':'s are'} still open on the board. They stay on the board for the next volunteer — but you will need your PIN to get back in.`
        : 'You will need your PIN to get back in. If you are handing over to someone else, use 🔄 Handover instead so the checklist is recorded.',
      yes: 'Log out',
      no: 'Stay logged in',
      danger: true,
    });
    if(ok) logout();
  };
  $('#btnHistory').onclick = openHistory;
  $('#btnIngUsed').onclick = showIngredientUsage;
  // The stats strip is visible by default now, so this button collapses it —
  // it is no longer the only way to see the numbers at all.
  $('#btnStats').onclick = ()=>{
    statsCollapsed = !statsCollapsed;
    $('#posStats').classList.toggle('collapsed', statsCollapsed);
    $('#btnStats').textContent = statsCollapsed ? '📊 Show Stats' : '📊 Hide Stats';
  };
  document.getElementById('headerTutorial').onclick = async ()=>{
    // Still guarded, but by the same dialog as everything else: starting the tour
    // swaps the live board for mock data and stops the poll, which is genuinely
    // disruptive mid-service. What was wrong was not that Tutorial asked — it was
    // that Logout did not.
    if(!await posConfirm({
      title: 'Start the training tutorial?',
      body: 'The board is replaced with practice orders and live updates pause until the tour finishes. Nothing real is changed.',
      yes: '📖 Start tutorial',
      no: 'Not now',
    })) return;
    try{
      await initTrainingMode([]);
      // renderMain() itself schedules startTrainingTour when trainingMode
      // is true (see the tail of this function), so we must NOT schedule
      // it again here — doing so spawns a second TourGuide instance and
      // produces duplicate "Do it →" buttons.
      renderMain();
    } catch(e){ showError('Failed to start tutorial'); }
  };
  $('#btnView').onclick = ()=>{ viewMode = viewMode==='kanban'?'list':'kanban'; renderBoard(); $('#btnView').textContent = viewMode==='kanban'?'📋 List':'📊 Kanban'; };
  $('#orderSearch').oninput = e=>{ searchFilter=e.target.value.toLowerCase(); renderBoard(); };
  $('#btnFeatured').onclick = openFeaturedDrinkModal;
  fetchCafeStatus();
  fetchOrders();
  startPolling();
  if(typeof trainingMode !== 'undefined' && trainingMode && typeof startTrainingTour === 'function'){
    // Give the board a moment to render with mock data, then start tour
    setTimeout(startTrainingTour, 1000);
  }
}

async function fetchCafeStatus(){
  try{
    const s = await api('GET','/api/cafe/status');
    cafeOpen = s.cafeStatus === 'OPEN';
    celebrationMode = s.celebrationMode || false;
    celebrationPrice = Number(s.celebrationPrice) || 5;
    const toggle = $('#btnCafeToggle');
    const celeb = $('#btnCelebration');
    if(toggle){
      toggle.textContent = cafeOpen ? '☕ Close Café' : '☕ Open Café';
      toggle.classList.toggle('pos-action-cafe-open', cafeOpen);
      toggle.classList.toggle('pos-action-cafe-closed', !cafeOpen);
      // Clean up any legacy variant class that a previous render may have left
      toggle.classList.remove('pos-action-danger');
    }
    if(celeb){
      celeb.classList.toggle('active', celebrationMode);
      celeb.textContent = celebrationMode ? '🎉 Celebration: ON' : '🎉 Celebration: OFF';
      celeb.setAttribute('aria-pressed', celebrationMode ? 'true' : 'false');
    }
    const banner = $('#celebBanner');
    if(banner) banner.classList.toggle('visible', celebrationMode);
    const closedBanner = $('#closedBanner');
    if(closedBanner) closedBanner.classList.toggle('visible', !cafeOpen);
    // One renderer for the badge AND the sidebar dot. They used to be updated in
    // different places — the badge here, the dot only by renderMain() from a
    // `cafeOpen` that is false at boot — which is why a grey dot sat beside a
    // green OPEN badge for an entire shift after login.
    const headerBadge = document.getElementById('headerCafeBadge');
    if(headerBadge) renderCafeBadge(headerBadge);
    // Handover button visibility
    const handoverBtn = document.getElementById('btnHandover');
    if(handoverBtn) handoverBtn.style.display = cafeOpen ? '' : 'none';
    // Featured drink
    featuredDrink = s.featuredDrink || null;
    const featBtn = $('#btnFeatured');
    if(featBtn){
      featBtn.textContent = featuredDrink ? `⭐ ${featuredDrink.name}` : '⭐ Set Featured';
      featBtn.classList.toggle('pos-btn-featured-active', !!featuredDrink);
    }
  } catch(e){}
}

function startPolling(){ stopPolling(); pollTimer = setInterval(fetchOrders, 7000); }
function stopPolling(){ if(pollTimer){ clearInterval(pollTimer); pollTimer=null; } }

let prevReceiptCount = 0;
// Snapshot of the previous fetch keyed by orderId → { updatedAt, status }.
// Used to detect mutations (updatedAt change) and customer cancellations
// (visible PENDING order disappearing) between consecutive 7s polls.
let prevOrdersById = {};

async function fetchOrders(){
  try{
    // Fetch queue + shift summary in parallel — one poll cycle updates both
    // the queue view and the stats bar without doubling backend load. Shift
    // summary is used by renderStats for the completed/revenue numbers that
    // the live queue alone can't compute (ARCHIVED isn't in the queue).
    const [data, summaryData] = await Promise.all([
      api('GET','/api/pos/orders'),
      api('GET','/api/pos/shift-summary').catch(() => null),
    ]);
    if (summaryData) shiftSummary = summaryData;
    const list = Array.isArray(data) ? data : data.orders || [];
    if(list.length > prevOrderCount && prevOrderCount > 0) flashNew();
    const receiptCount = list.filter(o=>o.receiptUrl).length;
    if(receiptCount > prevReceiptCount && prevReceiptCount > 0) playReceiptSound();
    prevReceiptCount = receiptCount;
    prevOrderCount = list.length;
    // Urgent = an unapproved walk-in customer waiting at the counter. Ministry
    // pre-orders are placed days ahead and sit PENDING until the cashier
    // releases them on Sunday, so they are never "late" — including them would
    // fire the urgent chime on every poll from Wednesday onwards.
    const urgentIds = list.filter(o=>o.status==='PENDING'&&!isPreOrder(o)&&(Date.now()-new Date(o.createdAt))>600000).map(o=>o.orderId||o.id);
    const newUrgent = urgentIds.filter(id=>!prevUrgentIds.includes(id));
    if(newUrgent.length) playUrgentSound();
    prevUrgentIds = urgentIds;

    // Diff vs previous fetch.
    const haveSeenPrev = Object.keys(prevOrdersById).length > 0;
    const currentById = {};
    const mutatedIds = [];
    list.forEach(o => {
      const id = o.orderId || o.id;
      currentById[id] = { updatedAt: o.updatedAt, status: o.status, customerName: o.customerName };
      const prev = prevOrdersById[id];
      if(haveSeenPrev && prev && prev.updatedAt && o.updatedAt && prev.updatedAt !== o.updatedAt){
        mutatedIds.push(id);
      }
    });
    const cancelledOrders = haveSeenPrev
      ? Object.keys(prevOrdersById)
          .filter(id => !currentById[id] && prevOrdersById[id].status === 'PENDING')
          .map(id => ({ id, customerName: prevOrdersById[id].customerName }))
      : [];

    orders = list;
    // A poll landed: the board is current again. Set BEFORE renderBoard so the
    // stale chrome is torn down in the same frame the fresh cards appear in.
    lastGoodFetch = Date.now();
    fetchFailed = false;
    renderBoard();

    // Apply flash to mutated cards after they exist in the DOM.
    if(mutatedIds.length){
      mutatedIds.forEach(id => {
        document.querySelectorAll(`.pos-card[data-id="${id}"]`).forEach(card => {
          card.classList.add('pos-card-mutated');
          setTimeout(() => card.classList.remove('pos-card-mutated'), 1500);
        });
      });
      playNotifSound();
    }

    cancelledOrders.forEach(o => {
      const shortId = String(o.id).slice(-4);
      const who = o.customerName ? `${o.customerName}'s order` : `Order #${shortId}`;
      showCancelToast(`${who} was cancelled by customer`);
    });
    if(cancelledOrders.length) playCancelSound();

    prevOrdersById = currentById;
  } catch(e){
    // THE failure path. It used to do nothing but call showError(), which
    // auto-hides after 3s against a 7s poll — so the board rendered whatever it
    // last had (or nothing at all, on the first poll) under a green OPEN badge,
    // and the only warning was absent 4 seconds out of every 7.
    //
    // Now: mark the data stale and RENDER. renderBoard() draws the lane skeleton
    // either way, renderConnectionState() puts up a panel that does not auto-hide,
    // and every action goes inert. `orders` is deliberately left ALONE — the last
    // known board is more use to a cashier than an empty one, as long as the screen
    // is honest about its age, which is what the banner and the STALE pill do.
    //
    // 401 is not a connection fault: api() has already called logout() and there is
    // no session left to show a stale board to.
    if(e.message === 'Unauthorized') return;
    fetchFailed = true;
    renderBoard();
  }
}

function flashNew(){
  document.body.classList.add('pos-flash');
  setTimeout(()=>document.body.classList.remove('pos-flash'),600);
  playNotifSound();
}

function playNotifSound(){
  try{
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.frequency.setValueAtTime(880, ctx.currentTime);
    osc.frequency.setValueAtTime(1100, ctx.currentTime + 0.1);
    gain.gain.setValueAtTime(0.3, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.3);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 0.3);
  } catch(e){}
}

function playReceiptSound(){
  try{
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.frequency.setValueAtTime(523, ctx.currentTime);
    osc.frequency.setValueAtTime(659, ctx.currentTime + 0.15);
    osc.frequency.setValueAtTime(784, ctx.currentTime + 0.3);
    gain.gain.setValueAtTime(0.25, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.5);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 0.5);
  } catch(e){}
}

function playUrgentSound(){
  try{
    const ctx = new (window.AudioContext||window.webkitAudioContext)();
    const osc = ctx.createOscillator(); const gain = ctx.createGain();
    osc.type='square'; osc.connect(gain); gain.connect(ctx.destination);
    osc.frequency.setValueAtTime(440,ctx.currentTime);
    osc.frequency.setValueAtTime(880,ctx.currentTime+0.15);
    osc.frequency.setValueAtTime(440,ctx.currentTime+0.3);
    gain.gain.setValueAtTime(0.2,ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01,ctx.currentTime+0.5);
    osc.start(ctx.currentTime); osc.stop(ctx.currentTime+0.5);
  } catch(e){}
}

// Distinct two-note descending chime for customer cancellations — different
// timbre from the new-order / receipt / urgent / ready chimes so cashiers
// can tell at a glance.
function playCancelSound(){
  try{
    const ctx = new (window.AudioContext||window.webkitAudioContext)();
    const osc = ctx.createOscillator(); const gain = ctx.createGain();
    osc.type='triangle'; osc.connect(gain); gain.connect(ctx.destination);
    osc.frequency.setValueAtTime(660, ctx.currentTime);
    osc.frequency.setValueAtTime(415, ctx.currentTime+0.18);
    gain.gain.setValueAtTime(0.25, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime+0.45);
    osc.start(ctx.currentTime); osc.stop(ctx.currentTime+0.45);
  } catch(e){}
}

// Lightweight transient toast in the top-right of the POS view. Stacks if
// multiple cancellations land in the same poll. Auto-dismisses after 5s.
function showCancelToast(msg){
  let host = document.getElementById('posToastHost');
  if(!host){
    host = document.createElement('div');
    host.id = 'posToastHost';
    host.style.cssText = 'position:fixed;top:16px;right:16px;display:flex;flex-direction:column;gap:8px;z-index:500;pointer-events:none';
    document.body.appendChild(host);
  }
  const t = document.createElement('div');
  t.className = 'pos-toast pos-toast-cancel';
  t.textContent = '❌ ' + msg;
  host.appendChild(t);
  setTimeout(()=>{ t.style.opacity='0'; setTimeout(()=>t.remove(), 300); }, 5000);
}

// True when an order has been modified within the last `windowMs` ms — used
// by the approve-guard to ask the cashier to re-verify items first.
function recentlyModified(o, windowMs){
  if(!o || !o.modifiedAt) return false;
  const ms = typeof windowMs === 'number' ? windowMs : 5000;
  return (Date.now() - new Date(o.modifiedAt)) < ms;
}

function approveGuardOk(orderId){
  const o = orders.find(x => (x.orderId||x.id) === orderId);
  if(!recentlyModified(o)) return true;
  return confirm('This order was modified moments ago — verify items before approving.');
}

function playReadySound(){
  try{
    const ctx=new (window.AudioContext||window.webkitAudioContext)();
    const osc=ctx.createOscillator();const gain=ctx.createGain();
    osc.connect(gain);gain.connect(ctx.destination);
    osc.frequency.setValueAtTime(660,ctx.currentTime);
    osc.frequency.setValueAtTime(880,ctx.currentTime+0.15);
    osc.frequency.setValueAtTime(1047,ctx.currentTime+0.3);
    gain.gain.setValueAtTime(0.3,ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01,ctx.currentTime+0.6);
    osc.start(ctx.currentTime);osc.stop(ctx.currentTime+0.6);
  }catch(e){}
}

function showNameFlash(name){
  const el=document.createElement('div');
  el.style.cssText='position:fixed;inset:0;display:flex;align-items:center;justify-content:center;background:rgba(19,106,60,.92);color:#fff;font-size:2.5rem;font-weight:800;z-index:999;animation:fadeIn .2s ease';
  el.textContent='🎉 '+name+' — READY!';
  document.body.appendChild(el);
  setTimeout(()=>el.remove(),2000);
}

function filtered(){ return searchFilter ? orders.filter(o=>(o.customerName||'').toLowerCase().includes(searchFilter)) : orders; }

/**
 * THE queue comparator. One function, used by the kanban lanes AND the list view,
 * because they used to disagree: the kanban applied a receipt-first tier and the
 * list did not, so the same order sat in a different position depending on which
 * button was last pressed.
 *
 * Two tiers:
 *
 *  1. RECEIPT FIRST. Someone who has uploaded payment proof outranks someone who
 *     tapped through the order form and walked away — this tier is production
 *     behaviour and is kept deliberately. It is the only signal on a PENDING card
 *     that a real human is committed to the transaction.
 *
 *  2. OLDEST FIRST within each tier. This is the change. It was `createdAt`
 *     DESCENDING, i.e. newest first, so the person who had waited LONGEST was
 *     rendered LAST: a 17-minute-old order came sixth, roughly 1100px below the
 *     fold, while the urgent chime and the red border fired on a card nobody
 *     could see. Preparing and Ready had no sort at all and came back in whatever
 *     order DynamoDB answered in.
 *
 * `createdAt` is used for every status, not `updatedAt` — a cashier is judging how
 * long the CUSTOMER has waited, and an unrelated edit must not send an order to
 * the back of the queue.
 */
function queueOrder(a, b){
  const ar = a.receiptUrl ? 0 : 1;
  const br = b.receiptUrl ? 0 : 1;
  if(ar !== br) return ar - br;
  // Oldest first. An unparseable/absent createdAt sorts last rather than
  // pretending to be from 1970 and hijacking the top of the lane.
  const at = new Date(a.createdAt).getTime();
  const bt = new Date(b.createdAt).getTime();
  const av = Number.isFinite(at) ? at : Infinity;
  const bv = Number.isFinite(bt) ? bt : Infinity;
  return av - bv;
}

// Orders of one status, filtered by the search box, in queue order.
function laneOrders(status){
  return filtered().filter(o => o.status === status).sort(queueOrder);
}

function renderStats(){
  // Pending INCLUDES ministry pre-orders, deliberately. The badge must equal the
  // number of rows visible in the Pending tab — if it says 5 and the volunteer
  // counts 7 cards, they will think the list is broken.
  const pending = orders.filter(o=>o.status==='PENDING').length;
  const preparing = orders.filter(o=>o.status==='PREPARING').length;
  const ready = orders.filter(o=>o.status==='READY').length;
  // There used to be a "Queue" stat here showing `orders.length`, which is exactly
  // Waiting + Making + Ready — all three of which sit next to it. A readout whose
  // value is the sum of its neighbours is furniture, and this strip is now on
  // screen permanently, so it has to earn its height.
  // "Completed" and "Revenue" come from /api/pos/shift-summary — the live
  // queue only carries PENDING/PREPARING/READY, so the queue-derived sum
  // can never see ARCHIVED sales. Falls back to queue-derived numbers if
  // the shift-summary fetch failed.
  const completed = shiftSummary?.completedOrders ?? 0;
  const revenue = shiftSummary?.totalRevenue ??
    orders.reduce((s,o)=>s+(o.total||o.totalAmount||0),0);
  // "Drinks" is what the baristas read to know what they have to make now, so it
  // EXCLUDES PENDING pre-orders: a pre-order placed on Wednesday is not being
  // made yet. The moment the cashier releases it, it becomes PREPARING and
  // starts counting here. Inflating this number days early would send the bar
  // chasing drinks nobody has asked for yet.
  const drinkItems = orders.filter(o=>o.status==='PREPARING'||(o.status==='PENDING'&&!isPreOrder(o))).reduce((s,o)=>s+(o.items||[]).filter(i=>i.category==='DRINK').reduce((ss,i)=>ss+(i.quantity||i.qty||1),0),0);
  // Two things on this bar are a QUEUE OF WORK rather than a reading: money
  // waiting to be checked, and pre-orders waiting to be released. Both were
  // discoverable only by spotting a badge on a card somewhere in the lane, or by
  // noticing the release button appear. They are prompts, so they sit apart from
  // the counts and only exist when the count is non-zero — a "0 receipts to check"
  // pill is furniture.
  const receipts = orders.filter(o=>o.receiptUrl).length;
  const dueToday = releasablePreOrders().length;
  const flags =
    (receipts ? `<span class="pos-flag pos-flag-receipt">💰 ${receipts} receipt${receipts===1?'':'s'} to check</span>` : '')
    + (dueToday ? `<span class="pos-flag pos-flag-preorder">🎉 ${dueToday} pre-order${dueToday===1?'':'s'} to release</span>` : '');

  const statsEl = $('#posStats');
  if(statsEl) statsEl.innerHTML = `<div class="pos-stat"><span class="pos-stat-num">${pending}</span><span class="pos-stat-lbl">⏳ Waiting</span></div>
    <div class="pos-stat"><span class="pos-stat-num">${preparing}</span><span class="pos-stat-lbl">☕ Making</span></div>
    <div class="pos-stat"><span class="pos-stat-num">${ready}</span><span class="pos-stat-lbl">🔔 Ready</span></div>
    <div class="pos-stat"><span class="pos-stat-num">${drinkItems}</span><span class="pos-stat-lbl">🥤 Drinks to make</span></div>
    <div class="pos-stat"><span class="pos-stat-num">${completed}</span><span class="pos-stat-lbl">✅ Done</span></div>
    <div class="pos-stat"><span class="pos-stat-num">RM${revenue.toFixed(2)}</span><span class="pos-stat-lbl">Revenue</span></div>
    ${flags ? `<span class="pos-flagstrip">${flags}</span>` : ''}`;
  updateReleaseAllButton();
}

// Show/hide the bulk-release button and keep its count honest. Called from
// renderStats, so it refreshes on every poll and after every board render.
function updateReleaseAllButton(){
  const btn = $('#btnReleasePreorders');
  if(!btn) return;
  const n = releasablePreOrders().length;
  btn.hidden = n === 0;
  btn.textContent = `🎉 Release ${n} pre-order${n === 1 ? '' : 's'}`;
  // Paused along with every other mutating action while the board is stale.
  btn.disabled = actionsPaused();
}

async function getRecipesAndIngredients(){
  const today = new Date().toISOString().slice(0,10);
  const cached = JSON.parse(localStorage.getItem('recipeCache') || '{}');
  if(cached.date === today && cached.recipes && cached.ingredients){
    return { recipes: cached.recipes, ingredients: cached.ingredients };
  }
  const invRes = await api('GET','/api/pos/inventory');
  const allItems = invRes.ingredients || [];
  const recipes = allItems.filter(i=>i.PK?.startsWith('RECIPE#'));
  const ingredients = allItems.filter(i=>i.PK?.startsWith('INGREDIENT#') && i.SK==='META');
  localStorage.setItem('recipeCache', JSON.stringify({ date: today, recipes, ingredients }));
  return { recipes, ingredients };
}

async function showIngredientUsage(){
  let recipes = [];
  let ingredients = [];
  let allOrders = [...orders];
  try{
    const cached = await getRecipesAndIngredients();
    recipes = cached.recipes;
    ingredients = cached.ingredients;
    // Try to get all today's orders (admin only), fall back to current POS orders
    try{
      const reportRes = await api('GET','/api/admin/reports/daily');
      const reportOrders = reportRes.orders || [];
      const activeIds = new Set(orders.map(o=>o.orderId));
      reportOrders.forEach(o=>{ if(!activeIds.has(o.orderId)) allOrders.push(o); });
    } catch(e){}
  } catch(e){}

  const ingMap = {};
  ingredients.forEach(i=>{ ingMap[i.ingredientId] = i; });

  // Build recipe lookup: menuItemId#variant -> [{ingredientId, quantity}]
  const recipeMap = {};
  recipes.forEach(r=>{
    const key = r.PK; // RECIPE#menuItemId#variant
    if(!recipeMap[key]) recipeMap[key] = [];
    recipeMap[key].push({ ingredientId: r.ingredientId, quantity: r.quantity });
  });

  // Calculate ingredient usage from orders (base + variant override)
  const usage = {};
  allOrders.forEach(o=>{
    (o.items||[]).forEach(i=>{
      const qty = i.quantity||i.qty||1;
      const menuId = i.menuItemId||i.id;
      const variant = i.variant||'default';
      const baseKey = `RECIPE#${menuId}#default`;
      const variantKey = `RECIPE#${menuId}#${variant}`;
      const baseRecipe = recipeMap[baseKey] || [];
      const variantRecipe = variant !== 'default' ? (recipeMap[variantKey] || []) : [];
      // Merge: start with base, then override with variant (variant replaces same ingredient, adds new ones)
      const merged = {};
      baseRecipe.forEach(r=>{ merged[r.ingredientId] = r.quantity; });
      variantRecipe.forEach(r=>{ merged[r.ingredientId] = r.quantity; });
      Object.entries(merged).forEach(([ingId, amount])=>{
        usage[ingId] = (usage[ingId]||0) + amount * qty;
      });
    });
  });

  const sorted = Object.entries(usage).sort((a,b)=>b[1]-a[1]);
  const modal = document.createElement('div');
  modal.className = 'pos-modal-overlay';
  modal.innerHTML = `<div class="pos-modal" style="max-width:400px;position:relative">
    <button class="pos-modal-close">✕</button>
    <h3>📦 Ingredients Used Today</h3>
    <button class="pos-btn pos-btn-sm" id="refreshRecipeCache" style="position:absolute;top:16px;right:16px">🔄 Refresh</button>
    <div style="margin-top:14px;max-height:60vh;overflow-y:auto">
      ${sorted.length ? sorted.map(([id,qty])=>{
        const ing = ingMap[id];
        const name = ing?.name || id;
        const unit = ing?.usageUnit || ing?.unit || '';
        return `<div style="display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--cream-dark)"><span>${name}</span><strong>${qty} ${unit}</strong></div>`;
      }).join('') : `<p style="color:var(--text-light)">${recipes.length ? 'No active orders with recipe data' : 'No recipe data yet. Set up recipes in Admin → Ingredients.'}</p>`}
    </div>
  </div>`;
  modal.querySelector('.pos-modal-close').onclick=()=>modal.remove();
  modal.querySelector('#refreshRecipeCache').onclick=()=>{ localStorage.removeItem('recipeCache'); modal.remove(); showIngredientUsage(); };
  modal.onclick=e=>{ if(e.target===modal) modal.remove(); };
  document.body.appendChild(modal);
}

// An empty lane that TEACHES. Three lanes each reading "No orders" over 90% dead
// space told a first-time volunteer nothing; the Waiting lane names the action,
// because "nobody has ordered yet" is exactly the moment a walk-up happens.
// `noMatch` is a different state and says so — the lane is not empty, the search
// box is hiding it.
function laneEmptyHtml(status){
  // A lane must never claim "nothing waiting" when the truth is "we could not ask".
  // This is the same defect as the empty board under a green OPEN badge, one level
  // down: the banner above says the fetch failed, so the lanes must not contradict
  // it with a confident reading of zero.
  if(fetchFailed){
    return `<div class="pos-col-empty pos-col-empty-unknown">
      <b>Not known</b>
      <p>${isColdFailure()
        ? 'This lane has never loaded.'
        : `Nothing has been received since ${escapeHtmlPos(clockStr(lastGoodFetch))}.`}
      There may be orders here that this screen cannot see yet.</p></div>`;
  }
  if(searchFilter){
    return `<div class="pos-col-empty"><b>No match</b>
      <p>Nobody in this lane matches “${escapeHtmlPos(searchFilter)}”.</p></div>`;
  }
  if(status === 'PENDING'){
    return `<div class="pos-col-empty">
      <b>Nothing waiting</b>
      <p>Tap ➕ Walk-up when someone comes to the counter.</p>
      <button class="pos-btn pos-btn-primary pos-empty-walkup"${disabledAttr()}>➕ Walk-up</button>
    </div>`;
  }
  if(status === 'PREPARING'){
    return `<div class="pos-col-empty"><b>Nothing being made</b>
      <p>Approved orders land here for the barista.</p></div>`;
  }
  return `<div class="pos-col-empty"><b>Nothing to hand over</b>
    <p>Drinks appear here once the barista marks them ready.</p></div>`;
}

// One lane. The scroll container is INSIDE the lane and wraps the header, which is
// what lets `position:sticky` pin the header to its own lane instead of the page.
function laneHtml(key, label, status, rows){
  const body = rows.length
    ? `<div class="pos-col-cards">${rows.map(cardHtml).join('')}</div>`
    : laneEmptyHtml(status);
  return `<section class="pos-col pos-col-${key}">
    <div class="pos-col-scroll">
      <h3 class="pos-col-hdr">${label}<span class="pos-col-n">${rows.length}</span></h3>
      ${body}
    </div>
  </section>`;
}

function renderBoard(){
  const board = $('#orderBoard');
  if(!board) return;
  renderStats();
  renderConnectionState();
  const pending   = laneOrders('PENDING');
  const preparing = laneOrders('PREPARING');
  const ready     = laneOrders('READY');
  if(viewMode==='kanban'){
    // `is-empty` lets the lanes size to their content rather than stretching into
    // three full-height hollow tubes when there is nothing on the board at all.
    const anyRows = pending.length + preparing.length + ready.length > 0;
    board.className = 'pos-board pos-kanban' + (anyRows ? '' : ' is-empty');
    board.innerHTML =
      laneHtml('pending','⏳ Waiting','PENDING',pending)
      + laneHtml('preparing','☕ Making','PREPARING',preparing)
      + laneHtml('ready','🔔 Ready','READY',ready);
  } else {
    const byStatus = { PENDING: pending, PREPARING: preparing, READY: ready };
    // `listTab` is module state, so the tab a volunteer chose survives the 7s
    // poll's re-render. Guard against a stale value from an older shell.
    if(!byStatus[listTab]) listTab = 'PENDING';
    const rows = byStatus[listTab];
    const tab = (s, label) =>
      `<button class="pos-tab${s===listTab?' active':''}" data-s="${s}">${label}` +
      `<span class="pos-tab-n">${byStatus[s].length}</span></button>`;
    board.className = 'pos-board pos-list-view';
    board.innerHTML = `<div class="pos-tabs">
      ${tab('PENDING','⏳ Waiting')}${tab('PREPARING','☕ Making')}${tab('READY','🔔 Ready')}
      </div>
      <div id="listItems" class="pos-list-items">${
        rows.length ? rows.map(cardHtml).join('') : laneEmptyHtml(listTab)
      }</div>`;
    board.querySelectorAll('.pos-tab').forEach(t=>t.onclick=()=>{
      listTab = t.dataset.s;
      renderBoard();
    });
  }
  board.querySelectorAll('.pos-empty-walkup').forEach(b=>b.onclick=e=>{
    e.stopPropagation();
    openWalkup();
  });
  bindCards();
}

/**
 * Renders the persistent connection-lost chrome. Called from renderBoard(), which
 * is now called on BOTH the success and failure paths of fetchOrders() — the whole
 * point being that the lane skeleton always renders, so an unreachable API can
 * never look like a quiet café.
 *
 * Nothing here auto-hides. It stays until a fetch succeeds.
 */
function renderConnectionState(){
  const banner = $('#staleBanner');
  const stamp  = $('#lastRefresh');
  const badge  = document.getElementById('headerCafeBadge');

  if(banner){
    if(fetchFailed){
      const cold = isColdFailure();
      // "as it was at HH:MM:SS — 5m 35s ago" is the load-bearing sentence: it
      // names what is on screen and how far behind it is.
      const what = cold
        ? 'The board below could not be loaded at all, so it is empty because of the fault — not because the queue is empty.'
        : `Showing the board as it was at ${clockStr(lastGoodFetch)} — ${ageStr(lastGoodFetch)} ago. New orders will not appear.`;
      banner.innerHTML = `<div class="pos-stale-txt">
          <strong>⚠️ Can't reach the café system</strong>
          <span>${what} Approve, Ready and Walk-up are paused until it is back.
          Retrying<span class="pos-retry-dots"><i></i><i></i><i></i></span></span>
        </div>
        <button class="pos-btn-retry" id="btnRetryFetch">🔄 Retry now</button>`;
      banner.classList.add('visible');
      const retry = $('#btnRetryFetch');
      if(retry) retry.onclick = async ()=>{
        if(retryInFlight) return;
        retryInFlight = true;
        retry.disabled = true;
        retry.textContent = 'Retrying…';
        try{ await fetchOrders(); } finally { retryInFlight = false; }
      };
    } else {
      banner.classList.remove('visible');
      banner.innerHTML = '';
    }
  }

  // The timestamp carries the STALE pill, because the timestamp is where a
  // cashier looks to judge whether what they are reading is current.
  if(stamp){
    if(fetchFailed){
      stamp.innerHTML = isColdFailure()
        ? '<span class="pos-stale-pill">NO DATA</span> Never loaded'
        : `<span class="pos-stale-pill">STALE</span> Last updated ${escapeHtmlPos(clockStr(lastGoodFetch))}`;
    } else if(lastGoodFetch){
      stamp.textContent = 'Updated ' + clockStr(lastGoodFetch);
    }
  }

  // A green "OPEN" over a board that failed to load is the single most misleading
  // thing this screen can show, so while the poll is failing the badge stops
  // asserting the present tense.
  if(badge) renderCafeBadge(badge);

  // On a COLD failure `cafeOpen` is still its boot default of false, so the red
  // "the café is closed" banner would be asserting a state nobody has confirmed —
  // two contradictory alarms at once, one of them invented. Suppress it and let the
  // connection panel be the single message; fetchCafeStatus() restores it as soon
  // as the real state is known.
  const closedBanner = $('#closedBanner');
  if(closedBanner && isColdFailure()) closedBanner.classList.remove('visible');

  // Every mutating control on the board chrome goes inert together. The card-level
  // buttons are rendered with `disabled` by cardHtml, so they need no sweep here.
  const paused = actionsPaused();
  ['#btnWalkup','#btnReleasePreorders','#btnFeatured'].forEach(sel=>{
    const el = $(sel);
    if(el) el.disabled = paused;
  });
}

// Header café badge — one place, three states. Previously written inline in
// fetchCafeStatus() with only OPEN and blank, which is why a failing poll left a
// confident green badge sitting over an empty board.
function renderCafeBadge(badge){
  badge.classList.remove('is-open','is-closed','is-stale');
  if(fetchFailed && cafeOpen && lastGoodFetch){
    badge.classList.add('is-stale');
    badge.textContent = `⏸ LAST SEEN OPEN · ${clockStr(lastGoodFetch)}`;
  } else if(fetchFailed){
    badge.classList.add('is-stale');
    badge.textContent = '⏸ NOT CONNECTED';
  } else if(cafeOpen){
    badge.classList.add('is-open');
    badge.textContent = '● OPEN';
  } else {
    badge.classList.add('is-closed');
    badge.textContent = '● CLOSED';
  }
  renderStatusDot();
}

// The sidebar status dot. It sat permanently grey on first login: renderMain()
// reads `cafeOpen`, which is false at boot, and fetchCafeStatus() then updated the
// badge, the toggle button and both banners — but never the dot. So a grey dot sat
// next to a green OPEN badge for the whole shift.
function renderStatusDot(){
  const dot = document.querySelector('.pos-status-dot');
  if(!dot) return;
  dot.classList.toggle('open', cafeOpen && !fetchFailed);
  dot.classList.toggle('closed', !cafeOpen && !fetchFailed);
  dot.classList.toggle('stale', fetchFailed);
  const txt = document.getElementById('posStatusText');
  if(txt) txt.textContent = fetchFailed ? 'STALE' : cafeOpen ? 'OPEN' : 'CLOSED';
  const chip = document.querySelector('.pos-status-chip');
  if(chip){
    chip.classList.toggle('is-open', cafeOpen && !fetchFailed);
    chip.classList.toggle('is-closed', !cafeOpen && !fetchFailed);
    chip.classList.toggle('is-stale', fetchFailed);
  }
}

function timeAgo(d){ const m=Math.floor((Date.now()-new Date(d))/60000); return m<1?'just now':m<60?`${m}m ago`:`${Math.floor(m/60)}h ${m%60}m ago`; }

// Auto-archive countdown for READY cards. Threshold matches Settings.archiveAfterMinutes
// (default 15 min). The cron actually performs the archive; this is a UX hint so
// cashiers know an order will disappear soon.
const ARCHIVE_AFTER_MIN = 15;
function archiveHint(o){
  if(o.status !== 'READY') return '';
  const anchor = o.readyAt || o.updatedAt;
  if(!anchor) return '';
  const elapsedMin = (Date.now() - new Date(anchor)) / 60000;
  const remaining = Math.max(0, ARCHIVE_AFTER_MIN - elapsedMin);
  let cls = 'pos-archive-hint';
  if(remaining <= 0)     cls += ' pos-archive-hint-overdue';
  else if(remaining < 2) cls += ' pos-archive-hint-soon';
  const label = remaining <= 0
    ? 'auto-archives any moment'
    : `auto-archives in ${Math.ceil(remaining)}m`;
  return `<div class="${cls}">⏱ ${label}</div>`;
}

function discountBadgeHtml(discountType) {
  if (!discountType || discountType === 'NONE') return '';
  // Pretty label + color-variant class. Fallback to title-case for any
  // future type so a new discountType shows up as a plain grey pill
  // rather than not at all.
  const meta = {
    NEWCOMER:          { label: 'Newcomer',    variant: 'newcomer' },
    STAFF:             { label: 'Staff',       variant: 'staff' },
    PASTOR:            { label: 'Pastor',      variant: 'pastor' },
    CELEBRATION:       { label: 'Celebration', variant: 'celebration' },
    MINISTRY_PREORDER: { label: 'Pre-Order',   variant: 'preorder' },
    VOUCHER:           { label: 'Voucher',     variant: 'voucher' },
  }[discountType];
  const label = meta?.label || (discountType.charAt(0) + discountType.slice(1).toLowerCase());
  const variant = meta?.variant || 'other';
  return `<span class="discount-badge discount-badge-${variant}">${label}</span>`;
}

function cardHtml(o){
  // Per-item notes ("less sugar" on ONE of three lattes). Shown on its own line
  // under the item it belongs to, in a different colour and prefixed 📝 so the
  // cashier can tell it apart from the order-level note lower down the card.
  // Absent on every order placed before the feature existed.
  // The quantity is its own fixed-width span so the drink names line up down the
  // card, and the variant is a distinct weight rather than parenthesised inline —
  // "Latte Large" is read faster than "Latte (Large)" at arm's length.
  const items = (o.items||[]).map(i=>{
    const note = typeof i.note === 'string' ? i.note.trim() : '';
    return `<div><span class="pos-card-qty">${i.quantity||i.qty||1}×</span>${escapeHtmlPos(i.name)}`
      + (i.variant?` <span class="pos-card-variant">${escapeHtmlPos(i.variant)}</span>`:'')
      + (note?`<span class="pos-item-note">📝 ${escapeHtmlPos(note)}</span>`:'')
      + `</div>`;
  }).join('');
  const mins = Math.floor((Date.now()-new Date(o.createdAt))/60000);
  const preOrder = isPreOrder(o);
  // Pre-orders are exempt from the urgent timer: they are legitimately days old.
  const urgent = mins > 10 && o.status === 'PENDING' && !preOrder;
  const hasReceipt = !!o.receiptUrl;
  let quickAction = '';
  // data-approve-label so the click handler can restore the right caption after
  // a failed approve without having to re-derive it from the order list.
  //
  // Approve and Ready are now DIFFERENT COLOUR FAMILIES. They were the same brown
  // `pos-btn-primary` pill in the same slot on the card, which made the one
  // transition a cashier performs dozens of times a service illegible by colour —
  // and the lane header naming the difference is usually scrolled out of view. A
  // pre-order release keeps the violet of its own ribbon, so button and card match.
  //
  // `disabled` while the board is stale: approving against a queue that may have
  // moved on is how an order gets approved twice.
  const off = disabledAttr();
  if(o.status==='PENDING'){
    const variant = preOrder ? 'pos-btn-preorder-release' : 'pos-btn-primary';
    quickAction = `<div class="pos-card-actions"><button class="pos-btn pos-btn-sm ${variant} pos-card-quick-approve" data-quick-id="${o.id||o.orderId}" data-approve-label="${approveLabel(o)}" onclick="event.stopPropagation()"${off}>${approveLabel(o)}</button></div>`;
  } else if(o.status==='PREPARING'){
    quickAction = `<div class="pos-card-actions"><button class="pos-btn pos-btn-sm pos-btn-ready pos-card-quick-ready" data-quick-id="${o.id||o.orderId}" onclick="event.stopPropagation()"${off}>🔔 Mark Ready</button></div>`;
  }

  // Price display: when a discount is applied show the gross (strikethrough)
  // next to the net collected. Gross reconstructed as net + offset since
  // totalAmount is stored as net across the codebase.
  const gross = Number(o.totalAmount || 0) + Number(o.discountOffset || 0);
  const net   = Number(o.total || o.totalAmount || 0);
  // The struck-through gross was inline `color:#999` — 2.85:1 on the white card.
  // It is now tinted from the warm hue by .pos-card-price s.
  const priceHtml = o.discountType && o.discountType !== 'NONE' && Number(o.discountOffset || 0) > 0
    ? `<s>RM ${gross.toFixed(2)}</s>RM ${net.toFixed(2)}`
    : `RM ${net.toFixed(2)}`;

  // The name already carries a PRE-ORDER pill, so the MINISTRY_PREORDER discount
  // pill underneath would say the same thing twice on a card the cashier scans in
  // a rush. Every other discount badge is unaffected.
  const showDiscountBadge = !!o.discountType && o.discountType !== 'NONE'
    && !(preOrder && o.discountType === 'MINISTRY_PREORDER');

  // Receipt badge. The mismatch warning compares the receipt against the order
  // total, which on a pre-order is RM0 — so ANY attached screenshot would show a
  // permanent "⚠️ expected RM0.00" that the cashier can do nothing about. A
  // pre-order has nothing to pay, so the amount is not a discrepancy: show the
  // badge plainly, no warning. (The backend also refuses receipt uploads on
  // pre-orders, and track.js no longer offers the upload UI for them, so this is
  // belt-and-braces for a record that already carries one.)
  const receiptMismatch = !preOrder && Math.abs((o.receiptAmount||0)-(o.total||o.totalAmount||0)) > 0.01;

  // The pre-order ribbon is the PRIMARY way a volunteer spots a pre-order in the
  // Pending tab, so it is a full-width band at the top of the card rather than an
  // inline chip: legible at arm's length on the counter iPad, and a different
  // SHAPE from both the faded `walk-up` chip and T2's blue staff tag, not just a
  // different colour. It sits above the receipt badge and the "✏️ modified" pill,
  // which remain their own stacked blocks, so nothing overlaps.
  //
  // A pre-order for a LATER service sits in the same Pending tab and is
  // deliberately left out of the bulk release, so its ribbon carries the service
  // date and a quieter shade. The loudest treatment is reserved for what the
  // volunteer has to act on today, and nobody hands next week's music team their
  // drinks by mistake.
  const preDueToday = preOrder && mytDate(o.expiresAt) === mytDate(Date.now());
  const preLaterDate = preOrder && !preDueToday ? mytDateShort(o.expiresAt) : '';
  const preRibbon = preOrder
    ? `<div class="pos-card-preorder-ribbon${preDueToday ? '' : ' pos-card-preorder-ribbon-later'}">🎉 PRE-ORDER${o.preorderCode ? ` · ${escapeHtmlPos(o.preorderCode)}` : ''}${preLaterDate ? ` · ${preLaterDate}` : ''}</div>`
    : '';

  // The wait time leads the card, because it is what decides who is served next —
  // it used to be the last, smallest, palest thing on it (2.54:1). READY says how
  // long ago it was called instead; a pre-order says when it was PLACED, since it
  // has legitimately been sitting there for days and "waiting 4d" is not a queue
  // position.
  const waitLine = o.status === 'READY'
    ? `<span class="pos-card-wait">Ready ${escapeHtmlPos(timeAgo(o.readyAt || o.updatedAt || o.createdAt))}</span>`
    : preOrder
      ? `<span class="pos-card-wait">Placed ${escapeHtmlPos(timeAgo(o.createdAt))}</span>`
      : `<span class="pos-card-wait${urgent?' pos-card-wait-urgent':''}">${urgent?'⚠️ waiting ':'waiting '}${escapeHtmlPos(timeAgo(o.createdAt)).replace(' ago','')}</span>`;

  // Hierarchy, and deliberately NOT uniform.
  //
  // On PENDING / PREPARING the DRINKS lead and the name is an attribution line in
  // the footer: those two cards exist to check a payment and to make an order. The
  // name was 1.15rem/800 — the loudest thing on the card — and the drinks were
  // 0.85rem in the palest ink, which is backwards for both jobs.
  //
  // READY inverts the inversion: nobody is making anything any more, the entire job
  // is to call a name, so on a READY card the name is the HEADLINE above the items
  // and the footer carries the order id instead.
  const who = `<span class="pos-card-who">${escapeHtmlPos(o.customerName||'Guest')}</span>`;
  const isReady = o.status === 'READY';
  const leadName = isReady ? `<p class="pos-card-lead">${who}</p>` : '';
  const footerLeft = isReady
    ? `<span class="pos-card-name">order ${escapeHtmlPos(String(o.id||o.orderId||'').slice(-6))}</span>`
    : `<span class="pos-card-name">for ${who}</span>`;
  // "cash at counter" was removed here: payment is QR-only (the DuitNow QR is
  // printed on the café tables), so there is no cash to collect on a walk-up
  // either. The tag now says only where the order came from.
  const tags = (o.isWalkUp?'<span class="pos-card-tag">🚶 walk-up</span>':'')
    + (o.staffCode?'<span class="pos-card-tag pos-card-tag-staff">🎫 staff price requested — you decide</span>':'');

  return `<div class="pos-card pos-card-${o.status.toLowerCase()} ${preOrder?'pos-card-preorder':''} ${urgent?'pos-card-urgent':''} ${hasReceipt?'pos-card-receipt':''}" data-id="${o.id||o.orderId}" data-status="${o.status}">
    ${preRibbon}
    ${hasReceipt ? `<div class="pos-receipt-badge${receiptMismatch?' pos-receipt-mismatch':''}">💰 Receipt: RM${(o.receiptAmount||0).toFixed(2)}${receiptMismatch?' ⚠️ expected RM'+(o.total||o.totalAmount||0).toFixed(2):''}</div>` : ''}
    ${o.status==='PENDING' && o.modifiedAt ? '<div class="pos-card-modified">✏️ modified</div>' : ''}
    <div class="pos-card-top">${waitLine}</div>
    ${leadName}
    <div class="pos-card-items">${items||'—'}</div>
    ${o.notes ? '<div class="pos-card-note">📝 Order note: '+escapeHtmlPos(o.notes)+'</div>' : ''}
    <div class="pos-card-footer">${footerLeft}<span class="pos-card-price">${priceHtml}</span></div>
    ${archiveHint(o)}
    ${tags ? `<div class="pos-card-tags">${tags}</div>` : ''}
    ${showDiscountBadge ? `<div class="pos-card-discount">${discountBadgeHtml(o.discountType)}</div>` : ''}
    ${quickAction}
  </div>`;
}

// --- Approve (single path) ---
// Every implicit approve goes through here — the quick-approve button on the
// card, swipe-right, and the detail modal's "Payment Confirmed" — so a
// staff-price request cannot be approved without the cashier being asked, and a
// pre-order for a LATER service cannot be released on one stray tap.
// #btnNewcomer is deliberately NOT routed here: choosing Newcomer is already an
// explicit decision about the discount.
//
// Resolves true when the order was approved, false when the cashier dismissed
// either prompt (the order is left PENDING and untouched). Rejects on API
// failure, like the calls it replaces.
async function approveOrder(id){
  const o = orders.find(x => (x.orderId||x.id) === id);

  // Releasing a pre-order is what closes the customer's edit window, and it is
  // deliberately a human decision — there is no timer anywhere. The BULK release
  // is today-only, but this per-order path is not, so without this ask a
  // volunteer could release next week's pre-order on a mis-tap and silently
  // close that customer's window days early. The dated ribbon warns; only this
  // stops it. A pre-order due TODAY — the common case — is untouched and still
  // releases in one tap, and ordinary orders never reach this branch at all.
  if(isPreOrder(o) && !isPreOrderDueToday(id)){
    if(!await confirmReleaseNotToday(o)) return false;
  }

  const staffCode = o && o.staffCode ? String(o.staffCode) : '';
  if(!staffCode){
    await api('PUT',`/api/pos/orders/${id}/approve`,{approvedBy:currentUser});
    return true;
  }
  const choice = await askStaffPrice(o);
  if(!choice) return false;
  // Either way approvedBy records who decided. 'NONE' tells the backend to
  // reprice at full price — the backend is authoritative on the number.
  await api('PUT',`/api/pos/orders/${id}/approve`,{approvedBy:currentUser,discountType:choice});
  return true;
}

// Resolves 'STAFF' (keep RM5), 'NONE' (reprice at full price), or null when the
// cashier dismisses the dialog. window.confirm is unusable on the counter iPad,
// hence the modal.
function askStaffPrice(o){
  return new Promise(resolve => {
    const net   = Number(o.total || o.totalAmount || 0);
    const gross = Number(o.totalAmount || 0) + Number(o.discountOffset || 0);
    const overlay = document.createElement('div');
    overlay.className = 'pos-modal-overlay';
    overlay.style.zIndex = '650';   // above the order-detail modal
    overlay.innerHTML = `<div class="pos-modal" style="max-width:440px">
      <button class="pos-modal-close">✕</button>
      <h3>Staff price (RM${(window.CafePricing && CafePricing.STAFF_DRINK_PRICE) || 5}) requested — confirm this is staff?</h3>
      <p style="font-size:.9rem;color:var(--text-light);margin:10px 0 4px">
        ${escapeHtmlPos(o.customerName||'Guest')} used the staff link
        (code <strong style="font-family:monospace">${escapeHtmlPos(o.staffCode)}</strong>).
      </p>
      <div class="pos-detail-total" style="margin:10px 0">Staff price: RM ${net.toFixed(2)}${gross > net ? ` <s style="color:var(--ink-muted);font-weight:600">RM ${gross.toFixed(2)}</s>` : ''}</div>
      <div style="display:flex;flex-direction:column;gap:10px;margin-top:16px">
        <button class="pos-btn pos-btn-primary pos-btn-lg" id="spYes" style="width:100%">✓ Yes, staff price — RM ${net.toFixed(2)}</button>
        <button class="pos-btn pos-btn-lg" id="spNo" style="width:100%">Not staff — charge full price${gross > net ? ` (RM ${gross.toFixed(2)})` : ''}</button>
      </div>
      <p style="font-size:.8rem;color:var(--text-light);margin-top:12px">
        Closing this leaves the order pending. Your name is recorded either way.
      </p>
    </div>`;
    let settled = false;
    const done = value => { if(settled) return; settled = true; overlay.remove(); resolve(value); };
    overlay.querySelector('#spYes').onclick = () => done('STAFF');
    overlay.querySelector('#spNo').onclick  = () => done('NONE');
    overlay.querySelector('.pos-modal-close').onclick = () => done(null);
    overlay.onclick = e => { if(e.target === overlay) done(null); };
    document.body.appendChild(overlay);
  });
}

/**
 * Bulk release of today's ministry pre-orders (PENDING → PREPARING for each).
 *
 * `PUT /api/pos/preorders/release-all` takes no body — the acting cashier comes
 * from the JWT — and answers `{ released, skipped, total }`. `skipped` is normal,
 * not an error: a customer may have cancelled or edited in the meantime, another
 * volunteer may have released it first, or the order belongs to a later service.
 * So the result is reported as-is instead of being rounded up to "done".
 *
 * There is deliberately NO timer and no automatic release anywhere in this file:
 * the cashier's explicit action is what closes the customer's edit window, and
 * doing it on a clock would close it behind their back.
 */
async function releaseAllPreorders(){
  const due = releasablePreOrders();
  if(!due.length){ showError('No pre-orders due today'); return; }
  if(!await confirmReleaseAll(due)) return;

  const btn = $('#btnReleasePreorders');
  const prevLabel = btn ? btn.textContent : '';
  if(btn){ btn.disabled = true; btn.textContent = 'Releasing…'; }
  try{
    const r = await api('PUT','/api/pos/preorders/release-all');
    const released = Number(r?.released ?? 0);
    const skipped  = Number(r?.skipped ?? 0);
    const total    = Number(r?.total ?? (released + skipped));
    if(skipped > 0){
      // Honest partial result. Never dress this up as a full success.
      showError(`Released ${released} of ${total} — ${skipped} skipped (changed by a customer, already released, or not for today)`);
    } else if(released > 0){
      showSuccessToast(`Released ${released} pre-order${released === 1 ? '' : 's'} to the barista`);
    } else {
      showError('Nothing was released — the board may already be up to date');
    }
  } catch(e){
    if(e.message !== 'Unauthorized') showError('Release failed');
  } finally {
    if(btn){ btn.disabled = false; btn.textContent = prevLabel; }
    // Refetch either way so the board shows what actually happened.
    fetchOrders();
  }
}

// Count-first confirmation, using the existing .pos-modal-overlay pattern —
// window.confirm is unusable on the counter iPad (see askStaffPrice).
function confirmReleaseAll(due){
  return new Promise(resolve => {
    const n = due.length;
    const names = due.map(o => escapeHtmlPos(o.customerName || 'Guest'));
    const overlay = document.createElement('div');
    overlay.className = 'pos-modal-overlay';
    overlay.innerHTML = `<div class="pos-modal" style="max-width:420px">
      <button class="pos-modal-close">✕</button>
      <h3>Release ${n} pre-order${n === 1 ? '' : 's'} to the barista?</h3>
      <p style="font-size:.9rem;color:var(--text-light);margin:10px 0 4px">
        Only pre-orders for today's service are released. The customer can no longer
        edit an order once it is released.
      </p>
      <ul style="margin:10px 0 0;padding-left:18px;font-size:.9rem;max-height:34vh;overflow-y:auto">
        ${names.map(nm => `<li>${nm}</li>`).join('')}
      </ul>
      <div style="display:flex;flex-direction:column;gap:10px;margin-top:18px">
        <button class="pos-btn pos-btn-primary pos-btn-lg" id="raYes" style="width:100%">🎉 Release ${n} to barista</button>
        <button class="pos-btn pos-btn-lg" id="raNo" style="width:100%">Cancel</button>
      </div>
    </div>`;
    let settled = false;
    const done = v => { if(settled) return; settled = true; overlay.remove(); resolve(v); };
    overlay.querySelector('#raYes').onclick = () => done(true);
    overlay.querySelector('#raNo').onclick  = () => done(false);
    overlay.querySelector('.pos-modal-close').onclick = () => done(false);
    overlay.onclick = e => { if(e.target === overlay) done(false); };
    document.body.appendChild(overlay);
  });
}

/**
 * Generic yes/no confirmation, in the same `.pos-modal-overlay` shape as
 * askStaffPrice / confirmReleaseAll / confirmReleaseNotToday and for the same
 * reason those exist: window.confirm is unusable on the counter iPad.
 *
 * Resolves true only on the affirmative button. ✕, the negative button and a
 * backdrop tap all resolve false, so dismissing is always the safe outcome.
 *
 * `title` and `body` are OUR copy, never customer data — a caller passing a
 * customer name must escape it itself (see the escaping invariant: escaping is a
 * property of the render site).
 */
function posConfirm({ title, body, yes = 'Confirm', no = 'Cancel', danger = false }){
  return new Promise(resolve => {
    const overlay = document.createElement('div');
    overlay.className = 'pos-modal-overlay';
    overlay.style.zIndex = '660';
    overlay.innerHTML = `<div class="pos-modal" style="max-width:420px">
      <button class="pos-modal-close" aria-label="Close">✕</button>
      <h3>${title}</h3>
      ${body ? `<p style="font-size:.9rem;color:var(--ink-muted);margin:10px 0 4px">${body}</p>` : ''}
      <div style="display:flex;flex-direction:column;gap:10px;margin-top:18px">
        <button class="pos-btn ${danger ? 'pos-btn-danger' : 'pos-btn-primary'} pos-btn-lg" id="pcYes" style="width:100%">${yes}</button>
        <button class="pos-btn pos-btn-lg" id="pcNo" style="width:100%">${no}</button>
      </div>
    </div>`;
    let settled = false;
    const done = v => { if(settled) return; settled = true; overlay.remove(); resolve(v); };
    overlay.querySelector('#pcYes').onclick = () => done(true);
    overlay.querySelector('#pcNo').onclick  = () => done(false);
    overlay.querySelector('.pos-modal-close').onclick = () => done(false);
    overlay.onclick = e => { if(e.target === overlay) done(false); };
    document.body.appendChild(overlay);
    overlay.querySelector('#pcNo').focus();
  });
}

// Per-order guard for a pre-order that is NOT due today. Same dialog shape as
// confirmReleaseAll above (and askStaffPrice) rather than a third style, and for
// the same reason: window.confirm is unusable on the counter iPad. Dismissing —
// ✕, Cancel, or the backdrop — resolves false and the order stays PENDING, so
// the caller's existing failure path restores the card as-is.
//
// zIndex matches askStaffPrice so this also sits above an open order-detail
// modal when the release was started from there.
function confirmReleaseNotToday(o){
  return new Promise(resolve => {
    const when = mytDateLong(o && o.expiresAt);
    const name = escapeHtmlPos((o && o.customerName) || 'Guest');
    // Older records (or a shell reading a record with no usable expiresAt) get
    // the same warning without inventing a date to name.
    const heading = when
      ? `This pre-order is for ${when}. Release it to the barista now?`
      : `This pre-order is not for today's service. Release it to the barista now?`;
    const overlay = document.createElement('div');
    overlay.className = 'pos-modal-overlay';
    overlay.style.zIndex = '650';   // above the order-detail modal
    overlay.innerHTML = `<div class="pos-modal" style="max-width:420px">
      <button class="pos-modal-close">✕</button>
      <h3>${heading}</h3>
      <p style="font-size:.9rem;color:var(--text-light);margin:10px 0 4px">
        ${name}'s order is not for today, so it is left out of "Release today's
        pre-orders". Releasing it now sends it to the barista and the customer can
        no longer edit it.
      </p>
      <div style="display:flex;flex-direction:column;gap:10px;margin-top:18px">
        <button class="pos-btn pos-btn-primary pos-btn-lg" id="rntYes" style="width:100%">🎉 Release${when ? ` ${when}` : ''} to barista</button>
        <button class="pos-btn pos-btn-lg" id="rntNo" style="width:100%">Cancel — leave it pending</button>
      </div>
    </div>`;
    let settled = false;
    const done = v => { if(settled) return; settled = true; overlay.remove(); resolve(v); };
    overlay.querySelector('#rntYes').onclick = () => done(true);
    overlay.querySelector('#rntNo').onclick  = () => done(false);
    overlay.querySelector('.pos-modal-close').onclick = () => done(false);
    overlay.onclick = e => { if(e.target === overlay) done(false); };
    document.body.appendChild(overlay);
  });
}

function bindCards(){
  document.querySelectorAll('.pos-card').forEach(c=>{
    c.onclick=()=>openDetail(c.dataset.id);
    initSwipe(c);
  });
  document.querySelectorAll('.pos-card-quick-approve').forEach(btn=>btn.onclick=async(e)=>{
    e.stopPropagation();
    if(!approveGuardOk(btn.dataset.quickId)) return;
    // Restore the caption this card was rendered with — "✓ Approve" for a
    // walk-in, "Release to barista" for a pre-order.
    const label = btn.dataset.approveLabel || '✓ Approve';
    btn.disabled=true; btn.textContent='...';
    try{
      const ok = await approveOrder(btn.dataset.quickId);
      if(!ok){ btn.disabled=false; btn.textContent=label; return; }
      fetchOrders();
    }
    catch(err){ btn.disabled=false; btn.textContent=label; showError('Approve failed'); }
  });
  document.querySelectorAll('.pos-card-quick-ready').forEach(btn=>btn.onclick=async(e)=>{
    e.stopPropagation();
    btn.disabled=true; btn.textContent='...';
    try{ await api('PUT',`/api/pos/orders/${btn.dataset.quickId}/ready`); fetchOrders(); }
    catch(err){ btn.disabled=false; btn.textContent='🔔 Mark Ready'; showError('Ready failed'); }
  });
}

// --- Swipe gestures ---
function initSwipe(card){
  let startX=0, currentX=0, swiping=false;
  const threshold=80;

  card.addEventListener('touchstart',e=>{
    startX=e.touches[0].clientX;
    currentX=startX;
    swiping=true;
    card.style.transition='none';
  },{passive:true});

  card.addEventListener('touchmove',e=>{
    if(!swiping) return;
    currentX=e.touches[0].clientX;
    const dx=currentX-startX;
    if(Math.abs(dx)>10){
      card.style.transform=`translateX(${dx*0.5}px)`;
      card.style.opacity=1-Math.abs(dx)/300;
    }
  },{passive:true});

  card.addEventListener('touchend',async()=>{
    if(!swiping) return;
    swiping=false;
    const dx=currentX-startX;
    card.style.transition='var(--transition)';
    card.style.transform='';
    card.style.opacity='';

    const id=card.dataset.id;
    const status=card.dataset.status;

    // Swipe is a shortcut for the same mutations the card buttons perform, so it
    // honours the same pause. Without this the board's buttons would be visibly
    // inert while a swipe still fired a write against a queue we know is stale.
    if(actionsPaused()) return;

    if(dx>threshold){
      // Swipe right: advance state
      if(status==='PENDING'){
        // approveOrder prompts first on a staff-code order; a dismissed prompt
        // resolves false and the card simply stays where it is.
        try{ const ok = await approveOrder(id); if(ok) fetchOrders(); }catch(e){ showError('Approve failed'); }
      } else if(status==='PREPARING'){
        try{ await api('PUT',`/api/pos/orders/${id}/ready`); fetchOrders(); }catch(e){ showError('Ready failed'); }
      }
    } else if(dx<-threshold){
      // Swipe left: undo/reject
      if(status==='PENDING') openDetail(id);
      else if(status==='PREPARING'){
        try{ await api('PUT',`/api/pos/orders/${id}/undo`); fetchOrders(); }catch(e){ showError('Undo failed'); }
      }
    }
  });
}

// --- Order Detail ---
function openDetail(id){
  const o = orders.find(x=>(x.id||x.orderId)===id);
  if(!o) return;
  // Per-line price. On a pre-order the stored `unitPrice` is NOT stable across
  // the release boundary — create/edit store the full price and the approve-time
  // reprice rewrites it to 0 — so the same card would read RM8.00 while PENDING
  // and RM0.00 once released. Read `grossUnitPrice` for pre-orders so the number
  // stays put and the volunteer can see what was given away; the order-level
  // total below still shows RM0.00 via discountOffset. A field choice, not
  // arithmetic. Legacy records predating grossUnitPrice fall back to unitPrice.
  const linePrice = i => isPreOrder(o)
    ? Number(i.grossUnitPrice != null ? i.grossUnitPrice : (i.price || i.unitPrice || 0))
    : Number(i.price || i.unitPrice || 0);
  const items = (o.items||[]).map(i=>{
    // Same per-item note as the queue card, repeated here because the detail is
    // where a cashier looks when they are unsure what the card said.
    const note = typeof i.note === 'string' ? i.note.trim() : '';
    return `<li>${i.quantity||i.qty||1}x ${escapeHtmlPos(i.name)}${i.variant?' ('+escapeHtmlPos(i.variant)+')':''} <span style="color:var(--text-light);float:right">RM${(linePrice(i)*(i.quantity||i.qty||1)).toFixed(2)}</span>`
      + (note?`<span class="pos-item-note">📝 ${escapeHtmlPos(note)}</span>`:'')
      + `</li>`;
  }).join('');
  let actions = '';
  // A pre-order is RM0 — there is no payment to confirm, the cashier is simply
  // releasing it to the barista on the day.
  if(o.status==='PENDING') actions=`<button class="pos-btn pos-btn-primary pos-btn-lg" id="btnApprove">${isPreOrder(o) ? 'Release to barista' : '✓ Payment Confirmed'}</button>
    <button class="pos-btn pos-btn-lg pos-btn-preorder-release" id="btnNewcomer">🎁 Newcomer</button>
    <button class="pos-btn pos-btn-danger pos-btn-lg" id="btnReject">✗ Reject</button>`;
  else if(o.status==='PREPARING') actions=`<button class="pos-btn pos-btn-ready pos-btn-lg" id="btnReady">🔔 Mark Ready</button>
    <button class="pos-btn pos-btn-lg pos-btn-secondary" id="btnUndo">↩ Undo</button>`;
  else if(o.status==='READY') actions=`<button class="pos-btn pos-btn-collect pos-btn-lg" id="btnCollected">📦 Collected</button>
    <button class="pos-btn pos-btn-lg pos-btn-secondary" id="btnUndoReady">↩ Back to Preparing</button>
    <button class="pos-btn pos-btn-danger pos-btn-lg" id="btnCancelCompleted">✗ Cancel / Refund</button>`;

  const orderTime = new Date(o.createdAt).toLocaleTimeString('en-MY',{hour:'2-digit',minute:'2-digit'});

  const modal = document.createElement('div');
  modal.className='pos-modal-overlay';
  modal.innerHTML=`<div class="pos-modal">
    <button class="pos-modal-close">✕</button>
    <h3>${escapeHtmlPos(o.customerName||'Guest')}</h3>
    <p style="font-size:.82rem;color:var(--text-light);margin-top:4px">Ordered at ${orderTime} · ${timeAgo(o.createdAt)}${o.isWalkUp?' · Walk-up':''}</p>
    <ul class="pos-detail-items">${items}</ul>
    ${o.notes ? `<div style="background:var(--cream);padding:10px 12px;border-radius:8px;font-size:.85rem;margin-bottom:10px">📝 Order note: ${escapeHtmlPos(o.notes)}</div>` : ''}
    <div class="pos-detail-total">Total: RM ${(o.total||o.totalAmount||0).toFixed(2)}</div>
    ${o.discountType && o.discountType!=='NONE' ? `<div style="font-size:.85rem;color:var(--ink-quiet);margin-bottom:8px">Discount: ${o.discountType}</div>` : ''}
    ${isPreOrder(o) ? `<div style="background:var(--preorder-soft);color:var(--preorder-soft-ink);padding:10px 12px;border-radius:8px;font-size:.85rem;margin-bottom:10px">🎉 <strong>Ministry pre-order</strong>${o.preorderCode ? ` · <span style="font-family:monospace">${escapeHtmlPos(o.preorderCode)}</span>` : ''} — free, no payment due.${o.status==='PENDING' ? ' Release it to the barista when it should be made.' : ''}</div>` : ''}
    ${o.staffCode ? `<div style="background:var(--info-bg);color:var(--making-ink);padding:10px 12px;border-radius:8px;font-size:.85rem;margin-bottom:10px">🎫 <strong>Staff price requested</strong> via link <span style="font-family:monospace">${escapeHtmlPos(o.staffCode)}</span> — you will be asked to confirm on approve.</div>` : ''}
    <div class="pos-detail-actions">${actions}</div></div>`;
  document.body.appendChild(modal);
  modal.querySelector('.pos-modal-close').onclick=()=>modal.remove();
  modal.onclick=e=>{ if(e.target===modal) modal.remove(); };

  if(o.status==='PENDING'){
    modal.querySelector('#btnApprove').onclick=async()=>{ if(!approveGuardOk(id)) return; const ok = await approveOrder(id); if(!ok) return; modal.remove(); fetchOrders(); };
    modal.querySelector('#btnNewcomer').onclick=async()=>{ if(!approveGuardOk(id)) return; await api('PUT',`/api/pos/orders/${id}/approve`,{approvedBy:currentUser,discountType:'NEWCOMER'}); modal.remove(); fetchOrders(); };
    modal.querySelector('#btnReject').onclick=()=>showRejectDialog(id, modal);
  } else if(o.status==='PREPARING'){
    modal.querySelector('#btnReady').onclick=async()=>{ await api('PUT',`/api/pos/orders/${id}/ready`); modal.remove(); playReadySound(); showNameFlash(o.customerName); fetchOrders(); };
    modal.querySelector('#btnUndo').onclick=async()=>{ await api('PUT',`/api/pos/orders/${id}/undo`); modal.remove(); fetchOrders(); };
  } else if(o.status==='READY'){
    modal.querySelector('#btnCollected').onclick=async()=>{ await api('PUT',`/api/pos/orders/${id}/archive`); modal.remove(); fetchOrders(); };
    modal.querySelector('#btnUndoReady').onclick=async()=>{
      const btn = modal.querySelector('#btnUndoReady');
      btn.disabled = true;
      const prev = btn.textContent;
      btn.textContent = '…';
      try {
        await api('PUT',`/api/pos/orders/${id}/undo-ready`);
        modal.remove();
        fetchOrders();
      } catch(e){
        showError('Could not move back to Preparing');
        btn.disabled = false;
        btn.textContent = prev;
      }
    };
    modal.querySelector('#btnCancelCompleted').onclick=()=> showCancelCompletedDialog(id, modal);
  }
}

function showRejectDialog(id, parentModal){
  const reasons=['Out of stock','Customer cancelled','Payment issue','Other'];
  const d=document.createElement('div');
  d.className='pos-reject-picker';
  d.innerHTML=`<h4>Reject Reason</h4>${reasons.map(r=>`<button class="pos-btn pos-btn-sm">${r}</button>`).join('')}`;
  parentModal.querySelector('.pos-detail-actions').appendChild(d);
  d.querySelectorAll('button').forEach(b=>b.onclick=async()=>{
    await api('PUT',`/api/pos/orders/${id}/reject`,{reason:b.textContent});
    parentModal.remove(); fetchOrders();
  });
}

// Cashier-driven cancel for READY/ARCHIVED orders. Distinct from Reject
// (which only acts on PENDING) — this records cancelReason + cancelledBy
// on the order so daily reports can flag it as a refund line.
function showCancelCompletedDialog(id, parentModal){
  const presetReasons = ['Wrong order made', 'Customer no-show', 'Duplicate', 'Made by mistake'];
  const overlay = document.createElement('div');
  overlay.className = 'pos-modal-overlay';
  overlay.style.zIndex = '600';
  overlay.innerHTML = `<div class="pos-modal" style="max-width:420px">
    <button class="pos-modal-close">✕</button>
    <h3 style="color:var(--stale-ink)">Cancel / Refund Order</h3>
    <p style="font-size:.85rem;color:var(--text-light);margin:8px 0 14px">
      This marks the order as cancelled for reporting (refund line).
      Ingredients already used will not be returned to stock.
    </p>
    <div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:10px">
      ${presetReasons.map(r=>`<button class="pos-btn pos-btn-sm" data-preset="${r}">${r}</button>`).join('')}
    </div>
    <input id="ccReason" class="pos-input" placeholder="Reason (required)" maxlength="200" style="margin-bottom:12px">
    <div style="display:flex;gap:8px">
      <button class="pos-btn" id="ccBack" style="flex:1">Back</button>
      <button class="pos-btn pos-btn-danger pos-btn-lg" id="ccConfirm" style="flex:2">Confirm Cancel</button>
    </div>
  </div>`;
  document.body.appendChild(overlay);
  overlay.onclick = e => { if(e.target === overlay) overlay.remove(); };
  overlay.querySelector('.pos-modal-close').onclick = ()=> overlay.remove();
  overlay.querySelector('#ccBack').onclick = ()=> overlay.remove();

  const reasonInput = overlay.querySelector('#ccReason');
  reasonInput.focus();
  overlay.querySelectorAll('[data-preset]').forEach(b=>{
    b.onclick = ()=>{
      reasonInput.value = b.dataset.preset;
      reasonInput.focus();
    };
  });

  overlay.querySelector('#ccConfirm').onclick = async ()=>{
    const reason = reasonInput.value.trim();
    if(!reason){ showError('Reason is required'); reasonInput.focus(); return; }
    const btn = overlay.querySelector('#ccConfirm');
    btn.disabled = true; btn.textContent = 'Cancelling…';
    try{
      await api('POST', `/api/pos/orders/${id}/cancel-completed`, { reason });
      overlay.remove();
      if(parentModal) parentModal.remove();
      try{ showSuccessToast('Order cancelled — will show as refund in reports'); }
      catch(e){ /* helper may not exist on older builds */ }
      fetchOrders();
    } catch(e){
      btn.disabled = false; btn.textContent = 'Confirm Cancel';
      const msg = String(e && e.message || '');
      if(msg.includes('no longer in a cancellable state')){
        showError('Order is no longer cancellable');
      } else {
        showError('Cancel failed');
      }
    }
  };
}

// --- Menu Toggle ---
async function openMenuToggle(){
  let menu=[];
  let menuSearch = '';
  // /api/pos/menu returns every admin-active item (isActive=true) regardless
  // of today's toggle, so the cashier can see + re-enable items that have
  // been switched off for the day. The public /api/menu would hide them.
  try{ const d=await api('GET','/api/pos/menu'); menu=Array.isArray(d)?d:d.items||[]; } catch(e){ showError('Failed to load menu'); return; }
  const drinks = menu.filter(m=>m.category==='DRINK').sort((a,b)=>{
    const top=['Long Black','Latte'];
    const strip=s=>s.replace(/^[\p{Emoji}\p{Emoji_Presentation}\s]+/u,'');
    const ai=top.indexOf(strip(a.name)),bi=top.indexOf(strip(b.name));
    if(ai!==-1&&bi!==-1)return ai-bi;
    if(ai!==-1)return -1;
    if(bi!==-1)return 1;
    return strip(a.name).localeCompare(strip(b.name));
  });
  const foodAll = menu.filter(m=>m.category==='FOOD');
  const modal=document.createElement('div');
  modal.className='pos-modal-overlay';

  function filterBySearch(items){
    if(!menuSearch) return items;
    return items.filter(m=>m.name.toLowerCase().includes(menuSearch));
  }

  function renderModal(){
    const food = foodAll.slice().sort((a,b)=>{
      if(!!a.isPinned!==!!b.isPinned)return a.isPinned?-1:1;
      const aq=Number(a.foodQuantityToday||0)>0, bq=Number(b.foodQuantityToday||0)>0;
      if(aq!==bq)return aq?-1:1;
      const strip=s=>s.replace(/^[\p{Emoji}\p{Emoji_Presentation}\s]+/u,'');
      return strip(a.name).localeCompare(strip(b.name));
    });
    const filteredDrinks = filterBySearch(drinks);
    const filteredFood = filterBySearch(food);
    modal.innerHTML=`<div class="pos-modal" style="max-width:600px">
      <button class="pos-modal-close">✕</button>
      <h3>Menu & Food Quantity</h3>
      <input id="menuSearchInput" class="pos-input" placeholder="Search menu..." value="${menuSearch}" style="margin-top:12px;margin-bottom:8px">
      <div style="margin-top:16px">
        <h4 style="margin-bottom:10px;color:var(--band)">🥤 Drinks</h4>
        <div class="pos-menu-toggles pos-menu-grid">${filteredDrinks.map(m=>`<div class="pos-menu-toggle-row${m.isEnabledToday===false?' is-disabled':''}" data-row-id="${m.menuItemId||m.id}">
          <span>${m.name}</span>
          <div style="display:flex;align-items:center;gap:8px">
            <button class="pos-pin-btn ${m.isPinned?'pinned':''}" data-pin-id="${m.menuItemId||m.id}" title="${m.isPinned?'Unpin':'Pin to top'}">📌</button>
            <label class="pos-switch"><input type="checkbox" data-id="${m.menuItemId||m.id}" data-type="toggle" ${m.isEnabledToday!==false?'checked':''}><span class="pos-slider"></span></label>
          </div>
        </div>`).join('')}</div>
      </div>
      <div style="margin-top:24px">
        <h4 style="margin-bottom:10px;color:var(--band)">🍔 Food — set today's quantity</h4>
        <div class="pos-menu-toggles pos-menu-grid">${filteredFood.map(m=>{
          const qty = m.foodQuantityToday || 0;
          const reserved = m.foodReserved || 0;
          const enabled = m.isEnabledToday !== false;
          return `<div class="pos-menu-toggle-row${enabled?'':' is-disabled'}" data-row-id="${m.menuItemId||m.id}" style="flex-wrap:wrap;gap:8px">
            <span style="flex:1;min-width:120px">${m.name}</span>
            <div style="display:flex;align-items:center;gap:8px">
              <button class="pos-pin-btn ${m.isPinned?'pinned':''}" data-pin-id="${m.menuItemId||m.id}" title="${m.isPinned?'Unpin':'Pin to top'}">📌</button>
              <label class="pos-switch"><input type="checkbox" data-id="${m.menuItemId||m.id}" data-type="toggle" ${enabled?'checked':''}><span class="pos-slider"></span></label>
              <button class="pos-btn pos-btn-sm" data-food-dec="${m.menuItemId||m.id}" style="width:36px;height:36px;border-radius:50%;padding:0">−</button>
              <input type="number" min="0" data-food-qty="${m.menuItemId||m.id}" value="${qty}" style="width:50px;text-align:center;font-weight:700;border:1px solid var(--cream-dark);border-radius:6px;padding:4px;font-size:1rem" class="pos-food-qty-input">
              <button class="pos-btn pos-btn-sm" data-food-inc="${m.menuItemId||m.id}" style="width:36px;height:36px;border-radius:50%;padding:0">+</button>
              ${reserved > 0 ? `<span style="font-size:.78rem;font-weight:700;color:var(--ink-muted)">(${reserved} reserved)</span>` : ''}
            </div>
          </div>`;
        }).join('')}</div>
      </div>
    </div>`;

    modal.querySelector('.pos-modal-close').onclick=()=>modal.remove();
    modal.onclick=e=>{ if(e.target===modal) modal.remove(); };

    modal.querySelector('#menuSearchInput').oninput=e=>{
      menuSearch=e.target.value.toLowerCase();
      renderModal();
      modal.querySelector('#menuSearchInput').focus();
    };

    modal.querySelectorAll('.pos-pin-btn').forEach(btn=>btn.onclick=async()=>{
      const id=btn.dataset.pinId;
      const item=menu.find(m=>(m.menuItemId||m.id)===id);
      try{
        await api('PUT',`/api/pos/menu/${id}/pin`);
        item.isPinned = !item.isPinned;
        btn.classList.toggle('pinned', item.isPinned);
      } catch(e){ showError('Pin failed'); }
    });

    modal.querySelectorAll('input[data-type="toggle"]').forEach(cb=>cb.onchange=async()=>{
      const id = cb.dataset.id;
      const item = menu.find(m=>(m.menuItemId||m.id)===id);
      const nextEnabled = cb.checked;
      try{
        await api('PUT',`/api/pos/menu/${id}/toggle`);
        if(item) item.isEnabledToday = nextEnabled;
        // Reflect greyed-out state on the row without a full re-render
        const row = modal.querySelector(`.pos-menu-toggle-row[data-row-id="${CSS.escape(id)}"]`);
        if(row) row.classList.toggle('is-disabled', !nextEnabled);
      }
      catch(e){ showError('Toggle failed'); cb.checked=!cb.checked; }
    });

    modal.querySelectorAll('[data-food-inc]').forEach(btn=>btn.onclick=async()=>{
      const id=btn.dataset.foodInc;
      const item=menu.find(m=>(m.menuItemId||m.id)===id);
      item.foodQuantityToday = (item.foodQuantityToday||0) + 1;
      try{
        await updateFoodQty(id, item.foodQuantityToday);
        modal.querySelector(`[data-food-qty="${id}"]`).value = item.foodQuantityToday;
      } catch(e){ item.foodQuantityToday--; showError('Update failed'); }
    });

    modal.querySelectorAll('[data-food-dec]').forEach(btn=>btn.onclick=async()=>{
      const id=btn.dataset.foodDec;
      const item=menu.find(m=>(m.menuItemId||m.id)===id);
      if((item.foodQuantityToday||0) <= 0) return;
      item.foodQuantityToday--;
      try{
        await updateFoodQty(id, item.foodQuantityToday);
        modal.querySelector(`[data-food-qty="${id}"]`).value = item.foodQuantityToday;
      } catch(e){ item.foodQuantityToday++; showError('Update failed'); }
    });

    modal.querySelectorAll('.pos-food-qty-input').forEach(inp=>inp.onchange=async()=>{
      const id=inp.dataset.foodQty;
      const item=menu.find(m=>(m.menuItemId||m.id)===id);
      const newQty=Math.max(0,parseInt(inp.value)||0);
      inp.value=newQty;
      try{ await updateFoodQty(id, newQty); item.foodQuantityToday=newQty; }
      catch(e){ inp.value=item.foodQuantityToday||0; showError('Update failed'); }
    });
  }

  renderModal();
  document.body.appendChild(modal);
}

async function updateFoodQty(menuItemId, qty){
  await api('PUT',`/api/pos/menu/${menuItemId}/quantity`, { foodQuantityToday: qty });
}

// --- Prep View ---
function openPrepView(){
  const preparing = orders.filter(o=>o.status==='PREPARING');
  const items = [];
  preparing.forEach(o=>{
    (o.items||[]).forEach(i=>{
      // `note` rides along per unit: this view flattens quantity into one row per
      // drink, and a per-item request belongs on every one of them.
      for(let n=0;n<(i.quantity||i.qty||1);n++) items.push({name:i.name,variant:i.variant,note:i.note,customer:o.customerName,notes:o.notes});
    });
  });
  const modal=document.createElement('div');
  modal.className='pos-modal-overlay';
  modal.innerHTML=`<div class="pos-modal" style="max-width:500px">
    <button class="pos-modal-close">✕</button>
    <h3>☕ Prep Queue (${items.length} drinks)</h3>
    <div style="margin-top:16px;max-height:60vh;overflow-y:auto">
      ${items.length ? items.map((it,i)=>{
        const itemNote = typeof it.note === 'string' ? it.note.trim() : '';
        return `<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;padding:10px 0;border-bottom:1px solid var(--cream-dark)">
        <div><strong>${escapeHtmlPos(it.name)}</strong>${it.variant?' <span style="color:var(--text-light)">('+escapeHtmlPos(it.variant)+')</span>':''}${itemNote?`<span class="pos-item-note">📝 ${escapeHtmlPos(itemNote)}</span>`:''}</div>
        <div style="text-align:right;font-size:.85rem"><span style="color:var(--band)">${escapeHtmlPos(it.customer)}</span>${it.notes?'<br><span style="color:var(--note-ink);font-size:.75rem">📝 Order note: '+escapeHtmlPos(it.notes)+'</span>':''}</div>
      </div>`;
      }).join('') : '<p style="color:var(--text-light);text-align:center;padding:24px">No orders being prepared</p>'}
    </div>
  </div>`;
  document.body.appendChild(modal);
  modal.querySelector('.pos-modal-close').onclick=()=>modal.remove();
  modal.onclick=e=>{ if(e.target===modal) modal.remove(); };
}

function showSuccessToast(msg){
  let host = document.getElementById('posToastHost');
  if(!host){
    host = document.createElement('div');
    host.id = 'posToastHost';
    host.style.cssText = 'position:fixed;top:16px;right:16px;display:flex;flex-direction:column;gap:8px;z-index:500;pointer-events:none';
    document.body.appendChild(host);
  }
  const t = document.createElement('div');
  t.className = 'pos-toast';
  t.style.cssText = 'background:var(--ready-fill);color:var(--on-brand);padding:10px 14px;border-radius:8px;font-weight:600;box-shadow:0 4px 12px rgba(0,0,0,.15);transition:opacity .3s';
  t.textContent = '✓ ' + msg;
  host.appendChild(t);
  setTimeout(()=>{ t.style.opacity='0'; setTimeout(()=>t.remove(), 300); }, 4000);
}

function escapeHtmlPos(s){
  return String(s == null ? '' : s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

// --- Featured Drink Modal ---
async function openFeaturedDrinkModal(){
  const modal = document.createElement('div');
  modal.className = 'pos-modal-overlay';

  if(featuredDrink){
    // Show current + option to unfeature
    modal.innerHTML = `<div class="pos-modal" style="max-width:400px;text-align:center">
      <button class="pos-modal-close">✕</button>
      <h3>⭐ Featured Drink</h3>
      <p style="margin:16px 0;font-size:1.1rem;font-weight:600">${featuredDrink.name}</p>
      <p style="color:var(--text-light);font-size:.85rem;margin-bottom:20px">RM ${featuredDrink.basePrice.toFixed(2)}</p>
      <button id="featUnset" class="pos-btn pos-btn-sm" style="background:var(--danger);color:#fff;width:100%">Remove Featured Drink</button>
    </div>`;
    document.body.appendChild(modal);
    modal.querySelector('.pos-modal-close').onclick = ()=> modal.remove();
    modal.onclick = e=>{ if(e.target===modal) modal.remove(); };
    modal.querySelector('#featUnset').onclick = async()=>{
      try{ await api('DELETE','/api/pos/featured-drink'); featuredDrink=null; fetchCafeStatus(); modal.remove(); showSuccessToast('Featured drink removed'); }
      catch(e){ showError('Failed to remove featured drink'); }
    };
    return;
  }

  // Show list of drinks to pick from
  let drinks = [];
  try{ const r = await api('GET','/api/pos/menu'); drinks = (r.items||r).filter(i=>i.category==='DRINK'&&i.isEnabledToday!==false); }
  catch(e){ showError('Failed to load menu'); return; }

  modal.innerHTML = `<div class="pos-modal" style="max-width:500px;max-height:80vh;overflow-y:auto">
    <button class="pos-modal-close">✕</button>
    <h3>⭐ Set Featured Drink</h3>
    <p style="color:var(--text-light);font-size:.85rem;margin:8px 0 16px">Pick one drink to feature on the order screen today.</p>
    <div class="pos-featured-list">
      ${drinks.map(d=>`<button class="pos-featured-pick" data-id="${d.menuItemId}">
        <span class="feat-name">${d.name}</span>
        <span class="feat-price">RM ${d.basePrice.toFixed(2)}</span>
      </button>`).join('')}
    </div>
  </div>`;
  document.body.appendChild(modal);
  modal.querySelector('.pos-modal-close').onclick = ()=> modal.remove();
  modal.onclick = e=>{ if(e.target===modal) modal.remove(); };
  modal.querySelectorAll('.pos-featured-pick').forEach(btn=>{
    btn.onclick = async()=>{
      try{ await api('PUT','/api/pos/featured-drink',{menuItemId:btn.dataset.id}); fetchCafeStatus(); modal.remove(); showSuccessToast('Featured drink set!'); }
      catch(e){ showError('Failed to set featured drink'); }
    };
  });
}

// --- Keyboard shortcuts ---
document.addEventListener('keydown', e=>{
  if(!token) return;
  if(e.target.tagName==='INPUT'||e.target.tagName==='SELECT') return;
  if(e.key==='w'||e.key==='W'){ e.preventDefault(); openWalkup(); }
  if(e.key==='v'||e.key==='V'){ e.preventDefault(); openVoucherFlow(); }
  if(e.key==='m'||e.key==='M'){ e.preventDefault(); openMenuToggle(); }
  if(e.key==='h'||e.key==='H'){ e.preventDefault(); openHistory(); }
  if(e.key==='p'||e.key==='P'){ e.preventDefault(); openPrepView(); }
  if(e.key==='s'||e.key==='S'){ e.preventDefault(); openStockCount('fridge'); }
  if(e.key==='/'){ e.preventDefault(); const s=$('#orderSearch'); if(s) s.focus(); }
});

