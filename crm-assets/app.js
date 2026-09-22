// ═══════ STATE ═══════
let leads = [];
let stages = [];
let enquiryTypes = ['Property Enquiry', 'Seller Listing', 'General'];
let filteredLeads = [];
let currentView = 'kanban';
let lastBrowseView = 'kanban';
let currentSearch = '';
let currentDetailId = null;
let lModalMode = 'add';
let lModalEditId = null;
let lmModalContactAt = null;
let stageManagerDraft = [];
let toastTimer;
let currentUserEmail = null;
let digestSettings = { enabled:false, recipients:[], emailEnabled:false, emails:[] };
let digestSettingsDraft = { enabled:false, recipients:[], emailEnabled:false, emails:[] };
// null recipients = "never saved yet" so openDashboardEmailManager() knows to
// pre-fill from the Follow-up Digest's email list exactly once; after the
// first save it's an independent array and never re-defaults again.
let dashboardEmailSettings = { enabled:false, recipients:null };
let dashboardEmailSettingsDraft = { enabled:false, recipients:[] };

const CHANNEL_META = {
  call: { label: 'Direct Call', icon: '📞' },
  whatsapp: { label: 'WhatsApp', icon: '🟢' },
  instagram: { label: 'Instagram', icon: '📸' },
  // Only TailorTalk's website chat sets this; the Add Lead form doesn't offer it.
  website: { label: 'Website Chat', icon: '🌐' }
};
function channelLabel(c){
  const m = CHANNEL_META[c];
  return m ? `${m.icon} ${m.label}` : '—';
}

// wa.me needs digits only, no leading zeros, with country code. Most leads
// here are 10-digit Indian mobile numbers with no country code typed in, so
// default to +91 — the only assumption we can make without asking the user.
function waHref(phone){
  if(!phone) return null;
  let digits = String(phone).replace(/\D/g,'');
  if(!digits) return null;
  if(digits.length===10) digits = '91'+digits;
  else if(digits.length===11 && digits.startsWith('0')) digits = '91'+digits.slice(1);
  return `https://wa.me/${digits}`;
}

// Canonical form of a phone number, used ONLY for duplicate detection and
// never for display. Deliberately identical to normPhone() in
// dashboardMetrics.js so the CRM's "already exists" check and the Dashboard's
// "duplicate phone numbers" hygiene count can never disagree.
function phoneKey(raw){
  const digits = String(raw || '').replace(/\D/g, '');
  if(!digits) return '';
  if(digits.length===10) return '91'+digits;
  if(digits.length===11 && digits.startsWith('0')) return '91'+digits.slice(1);
  return digits;
}
function findLeadByPhone(phone, excludeId){
  const key = phoneKey(phone);
  if(!key) return null;
  return leads.find(l => l.id !== excludeId && phoneKey(l.phone) === key) || null;
}

// ═══════ SNAPSHOT HANDLERS (called by firebase-sync.js) ═══════
window.applyLeadsSnapshot = function(list){
  // Notes + history now live in per-lead subcollections, so they don't arrive
  // in this snapshot. Preserve the threads we already loaded for the open lead
  // across the array swap so an incoming snapshot (e.g. right after saving a
  // note) doesn't blank out the notes/history panels.
  const openId = currentDetailId;
  const prev = openId ? leads.find(x => x.id === openId) : null;
  const keepNotes = prev ? prev.notes : undefined;
  const keepHistory = prev ? prev.history : undefined;
  leads = list;
  if(openId){
    const cur = leads.find(x => x.id === openId);
    if(cur){
      if(keepNotes !== undefined) cur.notes = keepNotes;
      if(keepHistory !== undefined) cur.history = keepHistory;
    }
  }
  refreshAll();
  try{ notifyNewMentions(); }catch(e){}
  // The AI summary regenerates server-side (see api/_lead-summary-generate.js)
  // and TailorTalk updates arrive from api/tailortalk.js — both come back
  // through this same snapshot. Refresh just the blocks they touch if the
  // lead's detail page is open, without touching any in-progress form state
  // elsewhere in the panel.
  if(currentDetailId && document.getElementById('dp').classList.contains('open')){
    const l = leads.find(x=>x.id===currentDetailId);
    if(l){
      renderAiSummary(l);
      renderStandSection(l);
      renderDetailStageRow(l);
      if(isTtLead(l)){
        renderDetailInfo(l);
        renderFollowUpSpotlight(l);
        renderTtSection(l);
        // A new TailorTalk event also wrote history/notes and a new profile.
        const cached = ttStateCache.get(l.id);
        if(!cached || cached.at !== l.tt.lastEventAt){ loadTtState(l); loadLeadThreads(l); }
      }
    }
  }
};
window.applyPipelineSnapshot = function(list){
  stages = list.slice().sort((a,b)=> (a.order||0) - (b.order||0));
  refreshAll();
};
window.applyEnquiryTypesSnapshot = function(list){
  enquiryTypes = (list && list.length) ? list : enquiryTypes;
  if(document.getElementById('lModal').classList.contains('open')){
    renderEnquiryTypeOptions(document.getElementById('lmEnquiryType').value);
  }
};
window.applyDigestSettingsSnapshot = function(settings){
  digestSettings = settings;
};
window.applyDashboardEmailSettingsSnapshot = function(settings){
  dashboardEmailSettings = settings;
};

// Rendering runs FIRST and the auxiliary passes are individually isolated:
// a throw in any of them (browser notification quirks, a bad metric) must
// never be able to leave the board/list showing stale-empty data. This was a
// real mobile bug — see checkFollowupNotify() for the specific case.
function refreshAll(){
  attnCache = new Map();
  if(currentView==='dashboard'){ if(window.renderDashboardView) window.renderDashboardView(); }
  else applyFilters();
  try{ renderLeadFilterBar(); } catch(e){ console.error('renderLeadFilterBar failed:', e); }
  try{ updateStats(); } catch(e){ console.error('updateStats failed:', e); }
  try{ updateFollowupBadge(); } catch(e){ console.error('updateFollowupBadge failed:', e); }
  try{ checkFollowupNotify(false); } catch(e){ console.error('checkFollowupNotify failed:', e); }
  try{ openPendingLead(); } catch(e){ console.error('openPendingLead failed:', e); }
}

// ═══════ INIT ═══════
function init(){
  setupSearch();
  setupMentions();
  updateNavState();
  renderLeadFilterBar();
  applyFilters();
  updateStats();
  updateNotifyBtnLabel();
  setInterval(()=>checkFollowupNotify(false), 15*60*1000);
  // Time-based reasons (a due time passing, a reply window closing) change without any data
  // change — redraw every minute so an overdue step turns red on its own.
  setInterval(()=>{ if(document.visibilityState === 'visible') refreshAll(); }, 60*1000);
  startLiveRefresh();
}

// ═══════ LIVE REFRESH + LEAD AUTOMATION SWITCH ═══════
// While the CRM is open it asks the server every 5 minutes for the newest TailorTalk updates and
// lets due AI reads run (api/tailortalk.js ?action=refresh). New data arrives through the normal
// Firestore snapshot; this only nudges the server. The switch lives in settings/{tenant}.
let leadAutomation = { enabled:false, model:null };
window.applyAutomationSettingsSnapshot = function(s){
  leadAutomation = { enabled: !!(s && s.enabled), model: (s && s.model) || null };
  updateAutomationBtn();
};
function updateAutomationBtn(){
  const btn = document.getElementById('autoBtn');
  if(btn) btn.textContent = leadAutomation.enabled ? '🤖 Lead automation: On' : '🤖 Lead automation: Off';
}
function toggleLeadAutomation(){
  closeMoreMenu();
  const next = !leadAutomation.enabled;
  const msg = next
    ? 'Turn on lead automation?\n\nThe AI will read TailorTalk chats when they go quiet, move leads forward on clear evidence, set follow-ups for promised steps, and suggest when unsure. Every move is logged and can be undone.'
    : 'Turn off lead automation?\n\nLeads stay where they are. Nothing is read or moved until you turn it back on.';
  if(!confirm(msg)) return;
  leadAutomation = { ...leadAutomation, enabled: next };
  if(window.crmFirebase && window.crmFirebase.saveAutomationSettings) window.crmFirebase.saveAutomationSettings({ enabled: next });
  updateAutomationBtn();
  showToast(next ? '🤖 Lead automation on' : 'Lead automation off');
  if(next) liveRefresh(true);
}
let liveRefreshTimer = null, liveRefreshRunning = false, lastLiveRefresh = 0;
function startLiveRefresh(){
  if(liveRefreshTimer) return;
  setTimeout(() => liveRefresh(false), 4000);
  liveRefreshTimer = setInterval(() => { if(document.visibilityState === 'visible') liveRefresh(false); }, 5*60*1000);
  document.addEventListener('visibilitychange', () => { if(document.visibilityState === 'visible' && Date.now() - lastLiveRefresh > 5*60*1000) liveRefresh(false); });
}
async function liveRefresh(loud){
  if(liveRefreshRunning || !window.crmAuth) return;
  liveRefreshRunning = true;
  lastLiveRefresh = Date.now();
  try{
    const idToken = await window.crmAuth.getIdToken();
    if(!idToken) return;
    const res = await fetch('/api/tailortalk?action=refresh', { method:'POST', headers:{ 'Authorization':'Bearer '+idToken } });
    const data = await res.json().catch(()=>({}));
    if(res.ok && data.ok){
      if(data.moved) showToast(`🤖 ${data.moved} lead${data.moved===1?'':'s'} moved by the AI`);
      else if(loud) showToast(data.aiRan ? `🤖 Read ${data.aiRan} lead${data.aiRan===1?'':'s'} — no moves needed` : '✓ Up to date');
    } else if(loud){
      showToast(data.error ? `Refresh failed: ${data.error}` : 'Refresh failed');
    }
  } catch(e){
    if(loud) showToast('Refresh failed — check your connection');
  } finally {
    liveRefreshRunning = false;
  }
}

// ═══════ BROWSER FOLLOW-UP ALERTS ═══════
// Per-device preference (localStorage, not synced) — a native OS
// notification while this tab is open, independent of the WhatsApp digest.
const FU_NOTIFY_KEY = 'fuNotifyEnabled';
const FU_NOTIFY_INTERVAL_MS = 60*60*1000; // don't re-notify more than once/hour
let fuNotifyEnabled = localStorage.getItem(FU_NOTIFY_KEY) === '1';
let fuLastNotifiedAt = 0;
function updateNotifyBtnLabel(){
  const btn = document.getElementById('fuNotifyBtn');
  if(!btn) return;
  btn.textContent = fuNotifyEnabled ? '🔔 Browser Alerts: On' : '🔕 Browser Alerts: Off';
}
async function toggleBrowserNotify(){
  if(!('Notification' in window)){ showToast('Notifications not supported in this browser'); return; }
  if(!fuNotifyEnabled){
    const perm = await Notification.requestPermission();
    if(perm!=='granted'){ showToast('Notification permission denied'); return; }
    // Probe with a real (confirming) notification: permission can be 'granted'
    // on mobile Chrome while the constructor still throws, so granting alone
    // is not proof the device can show one.
    try{
      new Notification('🔔 Browser alerts on', { body:'You\'ll be reminded about overdue follow-ups.', tag:'crm-followups' });
    } catch(e){
      console.warn('Browser notifications unsupported on this device:', e);
      showToast('This device can\'t show browser alerts — use the Follow-ups tab or the daily digest');
      return;
    }
    fuNotifyEnabled = true;
    localStorage.setItem(FU_NOTIFY_KEY,'1');
    showToast('✓ Browser alerts enabled');
    checkFollowupNotify(true);
  } else {
    fuNotifyEnabled = false;
    localStorage.setItem(FU_NOTIFY_KEY,'0');
    showToast('Browser alerts turned off');
  }
  updateNotifyBtnLabel();
}
function checkFollowupNotify(force){
  if(!fuNotifyEnabled) return;
  if(!('Notification' in window) || Notification.permission!=='granted') return;
  // Same number as the Follow-ups badge: leads that need a person now.
  const urgent = leads.filter(l => !isBusinessLead(l) && isUrgentUi(l));
  const critical = urgent.filter(l => { const t = topAttentionUi(l); return t && t.severity === 'critical'; }).length;
  const count = urgent.length;
  if(count<=0) return;
  const now = Date.now();
  if(!force && now-fuLastNotifiedAt < FU_NOTIFY_INTERVAL_MS) return;
  fuLastNotifiedAt = now;
  const body = critical ? `${critical} overdue or closing now · ${count - critical} more today` : `${count} lead${count===1?'':'s'} need a person today`;
  const buckets = { overdue: { length: critical }, today: { length: count - critical } };
  // Mobile Chrome/Android throws "Illegal constructor" here — the Notification
  // constructor is desktop-only there, and permission can still be 'granted',
  // so there's no feature test that predicts it. An unhandled throw used to
  // abort refreshAll() mid-flight and leave the board rendered empty on phones;
  // now it degrades to an in-app toast and turns the preference back off.
  try{
    const n = new Notification('🔴 Leads need attention', {
      body,
      tag: 'crm-followups'
    });
    n.onclick = () => { window.focus(); toggleView('followups'); n.close(); };
  } catch(e){
    console.warn('Browser notifications unsupported on this device:', e);
    fuNotifyEnabled = false;
    localStorage.setItem(FU_NOTIFY_KEY,'0');
    updateNotifyBtnLabel();
    showToast(`📅 ${buckets.overdue.length} overdue, ${buckets.today.length} due today`);
  }
}

function updateStats(){
  document.getElementById('statTotal').textContent = leads.length;
}

// ═══════ SEARCH / FILTER ═══════
function setupSearch(){
  const inp = document.getElementById('searchInput');
  inp.addEventListener('input', e=>{
    currentSearch = e.target.value.toLowerCase();
    document.getElementById('srchClear').classList.toggle('show', !!currentSearch);
    applyFilters();
  });
}
function clearSearch(){
  document.getElementById('searchInput').value='';
  currentSearch='';
  document.getElementById('srchClear').classList.remove('show');
  applyFilters();
}

function applyFilters(){
  attnCache = new Map();
  filteredLeads = leads.filter(l=>{
    if(!passesLeadFilter(l)) return false;
    if(currentSearch){
      const tt = isTtLead(l) ? [l.tt.status, l.tt.values && l.tt.values.propertyInterest, l.tt.values && l.tt.values.budget, l.tt.handle, l.tt.contact, l.tt.adTitle, l.ai && l.ai.line] : [];
      const hay = [l.name,l.phone,l.email,l.propertyInterest,l.enquiryType,l.budget,channelLabel(l.channel),...(l.propertyCodes||[]),...tt].join(' ').toLowerCase();
      if(!hay.includes(currentSearch)) return false;
    }
    return true;
  });
  if(currentView==='kanban') renderBoard();
  else if(currentView==='list') renderList();
  else if(currentView==='followups') renderFollowups();
  else if(currentView==='today' && window.renderTodayView) window.renderTodayView();
  updateViewsChip();
  // 'dashboard' renders itself (see dashboardView.js) — it reuses the same
  // in-memory `leads`/`filteredLeads` state but isn't a filtered list view.
}

// ═══════ TAILORTALK ═══════
// Leads that TailorTalk (the WhatsApp / Instagram / website AI agent) is talking to carry a
// small `tt` snapshot, written only by api/tailortalk.js — on every webhook and every pull. The
// AI profile, bookings and the whole conversation live in leads/{id}/tailortalk/state, read once
// when a lead is opened. Field ownership is explained at the top of api/_tailortalk-shared.js.
const TT_FOLLOW_FIELDS = ['name', 'propertyInterest', 'budget', 'enquiryType'];
const TT_FIELD_LABELS = { name:'Name', propertyInterest:'Property / Locality', budget:'Budget', enquiryType:'Enquiry type' };
const TT_STATUS = {
  hot:       { label:'Hot',       icon:'🔥' },
  warm:      { label:'Warm',      icon:'🌤️' },
  cold:      { label:'Cold',      icon:'❄️' },
  dead:      { label:'Dead',      icon:'⚫' },
  converted: { label:'Converted', icon:'✅' }
};
const TT_SOURCES = { whatsapp_ad:'WhatsApp ad', whatsapp_dm:'WhatsApp', whatsapp_campaign:'WhatsApp campaign', instagram_dm:'Instagram', instagram_ad:'Instagram ad', web_chat:'Website chat' };
const TT_PROFILE = [
  ['requirement_details','Requirement'], ['budget_and_finance','Budget & finance'],
  ['preferred_location','Preferred location'], ['intent_and_who','Intent & who'],
  ['properties_discussed','Properties discussed'], ['objections_and_blockers','Objections & blockers'],
  ['stage_and_next_action','Stage & next action'], ['activity_so_far','Activity so far'],
  ['chat_summary','Chat summary'], ['remarks','Remarks'], ['flag_details','Flag details']
];
// Same value as BUSINESS_ENQUIRY_TYPE in api/_tailortalk-shared.js.
const TT_BUSINESS_TYPE = 'Vendor / Collaboration';
const TT_CHAT_PAGE = 40;
const TT_WINDOW_MS = 24*60*60*1000;
const TT_FOLLOWUP_GAP_MS = 3*60*60*1000;
const TT_RETURN_GAP_MS = 24*60*60*1000;

// Custom-trigger signals (SIGNAL_DEFS in api/_tailortalk-shared.js — same keys).
//   tone     alert = money or trust is leaking now · action = someone should act · lost = closing out
//   quote    reply = show what 3 PIN said (the promise / the gap), else the lead's words
//   actions  followup · details · stage:<site_visit|negotiation|closed_lost>
const TT_SIGNALS = {
  moment:         { icon:'⚡', chip:'Key moment',        title:'Key moment — needs a look',        tone:'action', quote:'both',  actions:['followup'] },
  team_promise:   { icon:'🤝', chip:'Team promised',     title:'Team promised the lead something', tone:'alert',  quote:'reply', actions:['followup'] },
  needs_human:    { icon:'🙋', chip:'Needs a person',    title:'Needs a person now',               tone:'alert',  actions:['followup'] },
  site_visit:     { icon:'📅', chip:'Site visit',        title:'Site visit asked or agreed',       tone:'action', actions:['stage:site_visit','followup'] },
  ready_to_close: { icon:'💰', chip:'Ready to close',    title:'Negotiating or ready to book',     tone:'alert',  actions:['stage:negotiation','followup'] },
  no_match:       { icon:'🔍', chip:'No match',          title:'Nothing matched what they want',   tone:'action', quote:'reply', actions:['followup'] },
  owner_listing:  { icon:'🏷️', chip:'Owner listing',     title:'Owner wants to sell or rent out',  tone:'action', actions:['followup'] },
  revisit_later:  { icon:'⏰', chip:'Come back later',   title:'Postponed — come back later',      tone:'lost',   actions:['followup'] },
  lost_deal:      { icon:'💤', chip:'Stopped looking',   title:'Stopped looking',                  tone:'lost',   actions:['stage:closed_lost'] },
  loan_help:      { icon:'🏦', chip:'Needs a loan',      title:'Needs a home loan',                tone:'action', actions:['followup'] },
  shared_listing: { icon:'🔗', chip:'Asked about a post', title:'Asked about a specific post or listing', tone:'action', actions:['followup'] },
  ai_quality:     { icon:'⚠️', chip:'AI answer disputed', title:'AI answer disputed or stuck',     tone:'alert',  actions:['followup'] },
  // The first set, still understood if a webhook with these keys exists.
  wants_contact:   { icon:'🙋', chip:'Wants a call/visit', title:'Wants a call or visit',       tone:'action', actions:['followup'] },
  details_request: { icon:'📨', chip:'Wants details',      title:'Asked for property details',  tone:'action', actions:['details'] },
  seller_lead:     { icon:'🏷️', chip:'Seller',             title:'Owner wants to sell or list', tone:'action', actions:['followup'] },
  lost_signal:     { icon:'💤', chip:'Might be lost',      title:'Might be lost',               tone:'lost',   actions:['stage:closed_lost'] }
};
function ttSignalMeta(key){ return TT_SIGNALS[key] || { icon:'🔔', chip: prettyKey(key), title: prettyKey(key), tone:'action', actions:['followup'] }; }
function ttSignalQuote(key, s){
  const from = ttSignalMeta(key).quote;
  if(from==='both') return [s.quote, s.reply && `3 PIN: ${s.reply}`].filter(Boolean).join(' — ') || null;
  return from==='reply' ? (s.reply || s.quote) : (s.quote || s.reply);
}

function isTtLead(l){ return !!(l && l.tt && l.tt.id); }
// The separate CRM category: vendors, collaborations, influencers — anything TailorTalk files
// outside "sales", or a lead the team gave that enquiry type by hand.
function isBusinessLead(l){
  if(!l) return false;
  if(isTtLead(l) && l.tt.category && String(l.tt.category).toLowerCase() !== 'sales') return true;
  return l.enquiryType === TT_BUSINESS_TYPE;
}
function ttStatusLabel(s){ return TT_STATUS[s] ? TT_STATUS[s].label : (s ? s.charAt(0).toUpperCase()+s.slice(1) : ''); }
function ttSourceLabel(s){ return TT_SOURCES[s] || (s ? String(s).replace(/_/g,' ') : ''); }
function isNoReplyMarker(m){ return !!m && ((m.meta && m.meta.type==='no_response') || /^<no response from agent>$/i.test(String(m.content||'').trim())); }

// ── What needs a person ──
// Something is open only if it happened after BOTH the team's last touch on the lead (every CRM
// action moves updatedAt; TailorTalk's writes never do) and tt.attentionFrom (the import's
// 48-hour look-back, so weeks-old escalations don't flood the list).
function ttAttentionSince(l){ return Math.max(l.updatedAt || 0, (isTtLead(l) && l.tt.attentionFrom) || 0); }
function ttOpenSignals(l){
  if(!isTtLead(l) || !l.tt.signals) return [];
  const since = ttAttentionSince(l);
  return Object.entries(l.tt.signals).filter(([, s]) => s && s.at > since).sort((a, b) => b[1].at - a[1].at);
}
function ttOpenAlerts(l){
  if(!isTtLead(l)) return [];
  const t = l.tt, since = ttAttentionSince(l), out = [];
  if(t.escalated && t.escalatedAt && t.escalatedAt > since) out.push({ key:'escalated', at:t.escalatedAt });
  if(t.flagged && t.flaggedAt && t.flaggedAt > since) out.push({ key:'flagged', at:t.flaggedAt });
  if(t.awaitingTeamAt && t.awaitingTeamAt > since) out.push({ key:'waiting', at:t.awaitingTeamAt });
  return out;
}
function ttIsWaiting(l){ return ttOpenAlerts(l).some(a => a.key==='waiting'); }
function ttNeedsAttention(l){ return needsActionUi(l); }

// ═══════ PIPELINE, ATTENTION AND LEAD AUTOMATION (client side) ═══════
// What each column means lives in crm-assets/pipeline.js; what needs a person lives in
// crm-assets/leadAttention.js — both bridged onto window in crm.html and shared with the
// dashboard, the daily digest and the server-side AI. This block only draws them.
const SEV_RANK = { critical:3, high:2, medium:1, low:0 };
let attnCache = new Map();
function attentionFor(l){
  if(!l) return [];
  if(attnCache.has(l.id)) return attnCache.get(l.id);
  const api = window.leadAttention;
  const list = api ? api.computeAttention(l, { stages, now: Date.now(), signalLabel: key => ttSignalMeta(key).title }) : [];
  attnCache.set(l.id, list);
  return list;
}
function topAttentionUi(l){ return attentionFor(l)[0] || null; }
function needsActionUi(l){ return attentionFor(l).some(a => SEV_RANK[a.severity] >= SEV_RANK.medium); }
function isUrgentUi(l){ return attentionFor(l).some(a => SEV_RANK[a.severity] >= SEV_RANK.high); }

// ── What earns red ──
// Severity alone was too broad a test for colour: every TailorTalk signal is
// 'high', so nearly every chat lead carried an alert rail and the colour stopped
// meaning anything. Red on the board now means exactly one thing — something is
// past the time it was due — which is also precisely what the Overdue filter
// selects, so the board and the filter can never tell you different stories.
const OVERDUE_KEYS = new Set(['promise_overdue', 'followup_overdue', 'visit_outcome', 'window_closing']);
function isOverdueUi(l){ return attentionFor(l).some(a => OVERDUE_KEYS.has(a.key)); }
function stageKeyOfId(stageId){
  const s = stageById(stageId);
  return s && window.crmPipeline ? window.crmPipeline.stageKeyOf(s) : null;
}
function stageKindOfId(stageId){
  const s = stageById(stageId);
  return s && window.crmPipeline ? window.crmPipeline.stageKindOf(s) : null;
}
function stageIdForKey(key){
  const s = window.crmPipeline ? window.crmPipeline.stageForKey(stages, key) : null;
  return s ? s.id : null;
}
// The first time a lead enters a milestone column (lead.reached, see crm-assets/pipeline.js).
// Never overwritten — the funnel and "days to a visit" read these.
function markReached(l, stageId, at){
  const P = window.crmPipeline;
  const key = stageKeyOfId(stageId);
  if(!P || !P.reachedUpdate(l, key, at)) return;
  l.reached = { ...(l.reached || {}), [key]: at };
}
// The milestones a lead has reached, with dates: "New 3 Sep → Options sent 4 Sep → Visit planned 9 Sep".
function milestoneTrailHtml(l){
  const P = window.crmPipeline;
  const reached = l.reached || {};
  const steps = P ? P.LADDER.filter(k => reached[k]) : [];
  if(steps.length < 2) return '';
  const day = t => new Date(t).toLocaleDateString('en-IN', { day:'numeric', month:'short' });
  return `<div class="st-trail">${steps.map(k => { const s = stageById(stageIdForKey(k)); return `<span>${escapeHtml(s ? s.name : k)} <i>${day(reached[k])}</i></span>`; }).join('<b>→</b>')}</div>`;
}
// On a card only when a lead is stuck: "9d in stage", amber past the column's usual time, red past
// twice it. The exact age is always on the lead page.
function stageAgeHtml(l){
  const P = window.crmPipeline;
  const age = P && P.stageAge(l, stages);
  if(!age || !age.over) return '';
  const st = stageById(l.stageId);
  const title = `${age.days} days in ${st ? st.name : 'this column'} — usually ${age.target} or fewer`;
  return `<span class="lcard-age${age.farOver ? ' far' : ' over'}" title="${escapeHtml(title)}">${age.days}d in stage</span>`;
}
function stageRuleOf(stage){
  const key = window.crmPipeline ? window.crmPipeline.stageKeyOf(stage) : null;
  const def = key && window.crmPipeline.stageDef(key);
  return def ? def.rule : '';
}
function fmtDue(ts){
  if(!ts) return '';
  const d = new Date(ts), now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const tomorrow = new Date(now.getTime() + 86400000).toDateString() === d.toDateString();
  const time = d.toLocaleTimeString([], { hour:'numeric', minute:'2-digit' });
  if(sameDay) return `today ${time}`;
  if(tomorrow) return `tomorrow ${time}`;
  return d.toLocaleString([], { weekday:'short', day:'numeric', month:'short', hour:'numeric', minute:'2-digit' });
}

// The one line a card leads with: what happens next, and whose move it is.
function nextStepOf(l){
  const kind = stageKindOfId(l.stageId);
  if(kind === 'won') return { cls:'done', text:'Deal won' };
  if(kind === 'lost'){
    const r = window.crmPipeline && l.lostReason ? window.crmPipeline.LOST_REASONS[l.lostReason] : null;
    return { cls:'done', text: r ? `Lost — ${r}` : 'Lost' };
  }
  if(kind === 'hold' && l.holdUntil) return { cls:'wait', text:`Revisit ${fmtDue(l.holdUntil)}` };
  const ai = l.ai || {};
  const owes = window.leadAttention ? window.leadAttention.teamOwes(l) : null;
  if(owes) return { cls: owes.dueAt && owes.dueAt < Date.now() ? 'overdue' : 'team', text: owes.action, due: owes.dueAt };
  if(l.followUpAt) return { cls: l.followUpAt < Date.now() ? 'overdue' : 'team', text: l.followUpNote || 'Follow up', due: l.followUpAt };
  if(ai.next && ai.next.owner === 'lead') return { cls:'wait', text:`Waiting on lead: ${ai.next.action}` };
  if(ai.line) return { cls:'info', text: ai.line };
  return null;
}

// Reasons the next-step line itself already states — never repeated underneath it.
const STEP_KEYS = new Set(['team_owes', 'promise_overdue', 'followup_overdue']);

// ── Focus filters: the "what should I do now" views, available in every scope ──
// End of the working day in IST — "today" has to mean the team's today, not
// the browser's UTC day, or a 9 PM follow-up drops out of the list at 5:30.
function endOfTodayIst(now){
  const IST = 5.5 * 3600000, DAY = 86400000;
  return Math.floor(((now || Date.now()) + IST) / DAY) * DAY - IST + DAY - 1;
}
const FOCUS_FILTERS = [
  { key:'mentions', label:'@ Mentioned me', test: l => !!myOpenMention(l), tone:'warn', onlyWhenAny: true },
  { key:'action',   label:'Needs action',   test: l => needsActionUi(l), tone:'warn' },
  { key:'overdue',  label:'Overdue',        test: l => isOverdueUi(l), tone:'bad' },
  // Everything a person has to get through before going home: anything due by
  // the end of today, overdue included, since an overdue one is still today's.
  { key:'today',    label:'Due today',      test: l => {
      const end = endOfTodayIst();
      if(l.followUpAt && l.followUpAt <= end) return true;
      const owes = window.leadAttention ? window.leadAttention.teamOwes(l) : null;
      if(owes && owes.dueAt && owes.dueAt <= end) return true;
      const v = visitAtOf(l);
      return !!(v && v <= end);
    }, tone:'warn' },
  // Visits booked from now on, in the order they happen — the day's run sheet.
  { key:'visits',   label:'Site visits',    test: l => { const v = visitAtOf(l); return !!v && v > Date.now() - 12*3600000; } },
  { key:'ai_moved', label:'Moved by AI today', test: l => !!(l.ai && l.ai.lastMove && Date.now() - l.ai.lastMove.at < 24*3600000) },
  { key:'review',   label:'AI suggestions', test: l => attentionFor(l).some(a => a.key==='ai_suggestion') },
  // Owners who want to sell or rent out THEIR property, not a buyer/tenant looking for one —
  // golden leads, worth erring toward showing rather than hiding. Two independent signals, either
  // one is enough: enquiryType (isSellerEnquiryType — TailorTalk's own classifier or a hand edit,
  // same source the List view's Type column filters on) OR the per-lead AI's read of the WHOLE
  // conversation (l.ai.intent, api/_lead-ai.js). api/_lead-policy.js already copies a confident AI
  // "sell"/"rent_out" verdict onto enquiryType, but never when a person locked that field to
  // something else (ttHold) — this chip still catches that lead instead of losing it silently.
  { key:'sellers',  label:'Sellers & owners', test: l => isSellerLead(l) }
];

// ── Filter: Sales / TailorTalk / Other / Vendors & collabs, and within TailorTalk a status ──
// Per device (localStorage), like the theme — one person's working view, not a team setting.
const LEAD_FILTER_KEY = 'crmLeadFilter';
const LEAD_SCOPES = ['all', 'tt', 'other', 'business'];
let leadFilter = { scope:'all', status:null, focus:null };
try{
  const saved = JSON.parse(localStorage.getItem(LEAD_FILTER_KEY) || 'null');
  if(saved && LEAD_SCOPES.includes(saved.scope)) leadFilter = { scope: saved.scope, status: saved.scope==='tt' ? (saved.status || null) : null, focus: FOCUS_FILTERS.some(f=>f.key===saved.focus) ? saved.focus : null };
}catch(e){}

const TT_STATUS_FILTERS = [
  { key:'hot',       label:'Hot',       test:l=>l.tt.status==='hot' },
  { key:'warm',      label:'Warm',      test:l=>l.tt.status==='warm' },
  { key:'cold',      label:'Cold',      test:l=>l.tt.status==='cold' },
  { key:'dead',      label:'Dead',      test:l=>l.tt.status==='dead' },
  { key:'paused',    label:'AI paused', test:l=>l.tt.locked===true },
  { key:'converted', label:'Converted', test:l=>l.tt.converted===true }
];

function inScope(l, scope, status){
  const business = isBusinessLead(l);
  if(scope==='business') return business;
  if(business) return false;
  if(scope==='tt'){
    if(!isTtLead(l)) return false;
    const f = status && TT_STATUS_FILTERS.find(x=>x.key===status);
    return f ? f.test(l) : true;
  }
  if(scope==='other') return !isTtLead(l);
  return true;
}
function passesLeadFilter(l){
  if(propertyFilter) return (l.propertyCodes || []).includes(propertyFilter);
  if(!inScope(l, leadFilter.scope, leadFilter.status)) return false;
  const focus = leadFilter.focus && FOCUS_FILTERS.find(f => f.key===leadFilter.focus);
  return focus ? focus.test(l) : true;
}
function saveLeadFilter(){
  try{ localStorage.setItem(LEAD_FILTER_KEY, JSON.stringify(leadFilter)); }catch(e){}
}
function setLeadScope(scope){
  leadFilter = { scope: LEAD_SCOPES.includes(scope) ? scope : 'all', status:null, focus: leadFilter.focus };
  saveLeadFilter();
  renderLeadFilterBar();
  applyFilters();
}
function setLeadStatusFilter(key){
  leadFilter = { scope:'tt', status: leadFilter.scope==='tt' && leadFilter.status===key ? null : key, focus: leadFilter.focus };
  saveLeadFilter();
  renderLeadFilterBar();
  applyFilters();
}
function setLeadFocus(key){
  leadFilter = { ...leadFilter, focus: leadFilter.focus===key ? null : key };
  saveLeadFilter();
  renderLeadFilterBar();
  applyFilters();
}
function renderLeadFilterBar(){
  const el = document.getElementById('leadFilterBar');
  if(!el) return;
  const sales = leads.filter(l => !isBusinessLead(l));
  const ttSales = sales.filter(isTtLead);
  const business = leads.length - sales.length;
  const chip = (cls, pressed, onclick, label, n) =>
    `<button type="button" class="lf-chip${cls}${pressed?' at':''}" aria-pressed="${pressed}" onclick="${onclick}">${label}<span class="lf-n">${n}</span></button>`;
  if(propertyFilter){
    // Came from a property page: that property's leads, whatever their scope.
    if(!inventory) loadInventory().then(() => renderLeadFilterBar());
    const n = leads.filter(l => (l.propertyCodes || []).includes(propertyFilter)).length;
    el.innerHTML = `<button type="button" class="lf-chip prop at" onclick="clearPropertyFilter()" title="Show all leads again">🏠 Leads for ${escapeHtml(propertyShortLabel(propertyFilter))}<span class="lf-n">${n}</span><span aria-hidden="true">×</span></button>`;
    if(!document.getElementById('viewsCtlBtn')) renderViewsCtl();
    updateViewsChip();
    return;
  }
  let html = chip('', leadFilter.scope==='all', "setLeadScope('all')", 'Sales leads', sales.length)
    + chip(' tt', leadFilter.scope==='tt', "setLeadScope('tt')", 'TailorTalk', ttSales.length)
    + chip('', leadFilter.scope==='other', "setLeadScope('other')", 'Other sources', sales.length - ttSales.length)
    + chip(' biz', leadFilter.scope==='business', "setLeadScope('business')", 'Vendors &amp; collabs', business);
  const scoped = leads.filter(l => inScope(l, leadFilter.scope, leadFilter.status));
  html += '<span class="lf-sep" aria-hidden="true"></span>'
    + FOCUS_FILTERS.map(f => {
        const n = scoped.filter(f.test).length;
        if(f.onlyWhenAny && !n && leadFilter.focus !== f.key) return '';
        const tone = f.tone && n ? ' ' + f.tone : '';
        return chip(' sub focus'+tone, leadFilter.focus===f.key, `setLeadFocus('${f.key}')`, f.label, n);
      }).join('');
  if(leadFilter.scope==='tt'){
    html += '<span class="lf-sep" aria-hidden="true"></span>'
      + TT_STATUS_FILTERS.map(f => chip(' sub', leadFilter.status===f.key, `setLeadStatusFilter('${f.key}')`, f.label, ttSales.filter(f.test).length)).join('');
  }
  el.innerHTML = html;
  if(!document.getElementById('viewsCtlBtn')) renderViewsCtl();
  updateViewsChip();
}

// ═══════ SAVED TEAM VIEWS ═══════
// A named combination of scope, focus, TailorTalk status, search, board or list, and the list's
// sort and column filters — saved for the whole team in settings.views.{id}. Picking one restores
// all of it; the chip shows the view's name while nothing has been changed since.
let savedViews = {};
let viewsMenuOpen = false;
window.applyViewsSnapshot = function(map){
  savedViews = map && typeof map === 'object' ? map : {};
  renderViewsCtl();
};
function currentViewState(){
  const colFilters = {};
  Object.keys(listColumnFilters).sort().forEach(k => { colFilters[k] = [...listColumnFilters[k]].sort(); });
  const list = lastBrowseView === 'list';
  return {
    scope: leadFilter.scope, status: leadFilter.status || null, focus: leadFilter.focus || null,
    search: currentSearch || '', view: list ? 'list' : 'kanban',
    sortCol: list && listSortCol ? listSortCol : null, sortDir: list && listSortCol ? listSortDir : null,
    colFilters: list ? colFilters : {}
  };
}
const viewStateKey = s => JSON.stringify([s.scope, s.status || null, s.focus || null, (s.search || '').toLowerCase(), s.view, s.sortCol || null, s.sortDir || null, Object.keys(s.colFilters || {}).sort().map(k => [k, [...s.colFilters[k]].sort()])]);
function activeSavedView(){
  const key = viewStateKey(currentViewState());
  return Object.values(savedViews).find(v => v && viewStateKey(v) === key) || null;
}
function viewSummary(v){
  const scope = { all:'Sales leads', tt:'TailorTalk', other:'Other sources', business:'Vendors & collabs' }[v.scope] || 'Sales leads';
  const focus = v.focus && FOCUS_FILTERS.find(f => f.key === v.focus);
  const status = v.status && TT_STATUS_FILTERS.find(f => f.key === v.status);
  const cols = Object.keys(v.colFilters || {}).length;
  return [scope, status && status.label, focus && focus.label, v.search && `“${v.search}”`, v.view === 'list' ? 'List' : 'Board', cols && `${cols} column filter${cols === 1 ? '' : 's'}`].filter(Boolean).join(' · ');
}
function renderViewsCtl(){
  const el = document.getElementById('viewsCtl');
  if(!el) return;
  const typing = document.activeElement && document.activeElement.id === 'viewNameInput' ? document.activeElement.value : null;
  const active = activeSavedView();
  const list = Object.values(savedViews).filter(Boolean).sort((a, b) => String(a.name).localeCompare(String(b.name)));
  const menu = viewsMenuOpen ? `<div class="lf-views-menu" onclick="event.stopPropagation()">
      ${list.length ? list.map(v => `<div class="lf-view-row${active && active.id === v.id ? ' at' : ''}">
          <button type="button" class="lf-view-go" onclick="applySavedView('${escapeHtml(v.id)}')">${escapeHtml(v.name)}<small>${escapeHtml(viewSummary(v))}</small></button>
          <button type="button" class="lf-view-x" title="Delete this view" aria-label="Delete ${escapeHtml(v.name)}" onclick="deleteSavedView('${escapeHtml(v.id)}')">×</button>
        </div>`).join('') : '<div class="lf-views-empty">No saved views yet.</div>'}
      <div class="lf-views-save">
        <input id="viewNameInput" maxlength="40" placeholder="Name what you see now…" onkeydown="if(event.key==='Enter')saveCurrentView()">
        <button type="button" onclick="saveCurrentView()">Save</button>
      </div>
      <div class="lf-views-hint">Saves the filters, search, board or list and the list's sort — shared with the whole team.</div>
    </div>` : '';
  el.innerHTML = `<button type="button" id="viewsCtlBtn" class="lf-chip views${active ? ' on' : ''}" aria-expanded="${viewsMenuOpen}" onclick="toggleViewsMenu(event)">${active ? '★ ' + escapeHtml(active.name) : '☆ Views'}<span class="dd-chevron">⌄</span></button>${menu}`;
  if(typing !== null){ const inp = document.getElementById('viewNameInput'); if(inp){ inp.value = typing; inp.focus(); } }
}
// Only the chip's label follows the filters — the open menu (and a name being typed) is left alone.
function updateViewsChip(){
  const btn = document.getElementById('viewsCtlBtn');
  if(!btn) return;
  const active = activeSavedView();
  btn.classList.toggle('on', !!active);
  btn.innerHTML = `${active ? '★ ' + escapeHtml(active.name) : '☆ Views'}<span class="dd-chevron">⌄</span>`;
}
function toggleViewsMenu(e){
  if(e) e.stopPropagation();
  viewsMenuOpen = !viewsMenuOpen;
  renderViewsCtl();
  if(viewsMenuOpen){ const inp = document.getElementById('viewNameInput'); if(inp) inp.focus(); }
}
document.addEventListener('click', () => { if(viewsMenuOpen){ viewsMenuOpen = false; renderViewsCtl(); } });
async function saveCurrentView(){
  const inp = document.getElementById('viewNameInput');
  const name = (inp ? inp.value : '').trim().slice(0, 40);
  if(!name){ showToast('Give the view a name'); if(inp) inp.focus(); return; }
  const existing = Object.values(savedViews).find(v => v && String(v.name).toLowerCase() === name.toLowerCase());
  if(existing && !confirm(`Replace the saved view "${existing.name}" with what you see now?`)) return;
  const id = existing ? existing.id : 'v' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const view = { id, name, ...currentViewState(), createdBy: (existing && existing.createdBy) || currentUserEmail || null, createdAt: (existing && existing.createdAt) || Date.now(), updatedAt: Date.now() };
  savedViews = { ...savedViews, [id]: view };
  viewsMenuOpen = false;
  renderViewsCtl();
  try{ await window.crmFirebase.saveView(view); showToast(`✓ Saved view “${name}”`); }
  catch(e){ showToast('Could not save the view — check your connection'); }
}
async function deleteSavedView(id){
  const v = savedViews[id];
  if(!v || !confirm(`Delete the view "${v.name}" for everyone?`)) return;
  const { [id]: _gone, ...rest } = savedViews;
  savedViews = rest;
  renderViewsCtl();
  try{ await window.crmFirebase.deleteView(id); showToast('View deleted'); }
  catch(e){ showToast('Could not delete the view — check your connection'); }
}
function applySavedView(id){
  const v = savedViews[id];
  if(!v) return;
  leadFilter = {
    scope: LEAD_SCOPES.includes(v.scope) ? v.scope : 'all',
    status: v.scope === 'tt' && TT_STATUS_FILTERS.some(f => f.key === v.status) ? v.status : null,
    focus: FOCUS_FILTERS.some(f => f.key === v.focus) ? v.focus : null
  };
  saveLeadFilter();
  const inp = document.getElementById('searchInput');
  if(inp) inp.value = v.search || '';
  currentSearch = String(v.search || '').toLowerCase();
  const clr = document.getElementById('srchClear');
  if(clr) clr.classList.toggle('show', !!currentSearch);
  listSortCol = LIST_COLUMNS.some(c => c.key === v.sortCol) ? v.sortCol : null;
  listSortDir = v.sortDir === 'desc' ? 'desc' : 'asc';
  listColumnFilters = {};
  Object.entries(v.colFilters || {}).forEach(([k, vals]) => { if(LIST_COLUMNS.some(c => c.key === k && c.filterable) && Array.isArray(vals)) listColumnFilters[k] = new Set(vals); });
  bulkSelected = new Set();
  viewsMenuOpen = false;
  renderViewsCtl();
  renderLeadFilterBar();
  toggleView(v.view === 'list' ? 'list' : 'kanban');
}

// ── Board card ──
function ttCardHtml(l){
  if(!isTtLead(l)) return '';
  const t = l.tt, bits = [];
  ttOpenSignals(l).forEach(([key, s]) => {
    const m = ttSignalMeta(key);
    const q = ttSignalQuote(key, s);
    bits.push(`<span class="tt-chip ${m.tone==='lost'?'lost':m.tone==='alert'?'alert':'action'}" title="${escapeHtml(m.title + (q ? ' — “' + q + '”' : ''))}">${m.icon} ${escapeHtml(m.chip)}</span>`);
  });
  const alerts = ttOpenAlerts(l);
  if(alerts.some(a => a.key==='waiting')) bits.push('<span class="tt-chip action" title="The AI left the lead\'s latest message for the team">⏳ Waiting for team</span>');
  if(TT_STATUS[t.status]) bits.push(`<span class="tt-chip ${t.status}">${TT_STATUS[t.status].icon} ${TT_STATUS[t.status].label}</span>`);
  else if(t.status) bits.push(`<span class="tt-chip">${escapeHtml(ttStatusLabel(t.status))}</span>`);
  if(t.converted && t.status!=='converted') bits.push('<span class="tt-chip converted">✅ Converted</span>');
  if(t.escalated){
    const fresh = alerts.some(a => a.key==='escalated');
    bits.push(`<span class="tt-chip ${fresh?'alert':'muted'}" title="${escapeHtml(t.escalatedTo ? 'Escalated to '+t.escalatedTo : 'Escalated in TailorTalk')}">${fresh?'🚨 ':''}Escalated</span>`);
  }
  if(t.flagged){
    const fresh = alerts.some(a => a.key==='flagged');
    bits.push(`<span class="tt-chip ${fresh?'alert':'muted'}" title="${escapeHtml(t.flagDetails || 'Flagged in TailorTalk')}">${fresh?'🚩 ':''}Flagged</span>`);
  }
  if(t.locked) bits.push('<span class="tt-chip paused" title="The AI is paused on this chat in TailorTalk">🔒 AI paused</span>');
  if(t.lastMessageAt) bits.push(`<span class="tt-chip time" title="Last message from the lead">💬 ${timeAgo(t.lastMessageAt)}</span>`);
  return bits.length ? `<div class="lcard-tt">${bits.join('')}</div>` : '';
}
function sourceBadge(l){
  if(l.source==='tailortalk') return { cls:'tailortalk', text:'TailorTalk' };
  if(l.source==='meta') return { cls:'meta', text:'Meta' };
  if(l.source==='whatsapp_bot') return { cls:'meta', text:'WA Bot' };
  return { cls:'manual', text:'Manual' };
}

// ── Sync ──
// Walks every lead in TailorTalk one page per request (api/tailortalk.js ?action=sync) and
// applies each exactly like a webhook — new ones are added, changed ones updated, unchanged
// ones left untouched. The daily cron does the same for leads active since the last run.
let ttSyncRunning = false;
async function runTailorTalkSync(){
  if(ttSyncRunning) return;
  closeMoreMenu();
  ttSyncRunning = true;
  let startAfter = null, processed = 0, created = 0, updated = 0, failed = 0, guard = 0;
  showToast('Syncing TailorTalk…');
  try{
    while(guard++ < 200){
      const idToken = await window.crmAuth.getIdToken();
      if(!idToken){ showToast('Please log in again'); break; }
      const res = await fetch('/api/tailortalk?action=sync', {
        method: 'POST',
        headers: { 'Content-Type':'application/json', 'Authorization':'Bearer '+idToken },
        body: JSON.stringify(startAfter ? { startAfter } : {})
      });
      const data = await res.json().catch(()=>({}));
      if(!res.ok || !data.ok){ showToast(data.error ? 'Sync failed: '+data.error : 'Sync failed'); break; }
      processed += data.processed || 0; created += data.created || 0; updated += data.updated || 0; failed += data.failed || 0;
      if(data.done){
        showToast(`✓ TailorTalk synced — ${processed} checked${created?`, ${created} new`:''}${updated?`, ${updated} updated`:''}${failed?`, ${failed} failed`:''}`);
        break;
      }
      showToast(`Syncing TailorTalk… ${processed} checked${created?`, ${created} new`:''}`);
      startAfter = data.next;
    }
  } catch(e){
    console.error('runTailorTalkSync failed:', e);
    showToast('Sync failed — check your connection');
  } finally {
    ttSyncRunning = false;
  }
}

// ── Lead page ──
// leads/{id}/tailortalk/state, keyed by lead id and stamped with the tt.lastEventAt it was read
// at, so a newer TailorTalk event (seen through the leads snapshot) triggers one re-read.
const ttStateCache = new Map();
const ttStateLoading = new Set();
const ttChatExpanded = new Set();
const TT_TAB_KEY = 'crmTtTab';
let ttTab = 'overview';
// (The per-day Activity tab moved into the lead's Timeline.)
try{ const t = localStorage.getItem(TT_TAB_KEY); if(['overview','conversation'].includes(t)) ttTab = t; }catch(e){}

// ── Live conversation ──
// loadTtState below is a one-shot read, repeated only when tt.lastEventAt
// changes on the parent lead. Anything that wrote the chat without bumping
// that field — and the nightly bulk sync, which writes many messages at once —
// left the pane showing a stale conversation until the lead was reopened.
// While a lead is on screen we subscribe to its state document instead, so the
// write itself is what updates the view, whatever produced it.
let ttWatch = null;   // { id, stop }
function watchTtState(l){
  const F = window.crmFirebase;
  if(!l || !isTtLead(l) || !F || !F.watchLeadTailorTalk){ stopTtWatch(); return; }
  if(ttWatch && ttWatch.id === l.id) return;   // already on this lead
  stopTtWatch();
  const id = l.id;
  const stop = F.watchLeadTailorTalk(id, (state, err) => {
    // A lead can be closed between the subscribe and the first callback.
    if(!ttWatch || ttWatch.id !== id) return;
    const cur = leads.find(x => x.id === id);
    ttStateCache.set(id, {
      at: cur && cur.tt ? cur.tt.lastEventAt : null,
      state: state || null,
      error: err ? (err.code === 'permission-denied' ? 'rules' : 'load') : null
    });
    if(currentDetailId === id && document.getElementById('dp').classList.contains('open')){
      renderTtSection(cur || l);
      renderTimeline(cur || l);
    }
  });
  ttWatch = { id, stop: typeof stop === 'function' ? stop : null };
}
function stopTtWatch(){
  if(ttWatch && ttWatch.stop){ try{ ttWatch.stop(); }catch(e){} }
  ttWatch = null;
}

async function loadTtState(l){
  if(!isTtLead(l) || !window.crmFirebase || !window.crmFirebase.getLeadTailorTalk) return;
  if(ttStateLoading.has(l.id)) return;
  ttStateLoading.add(l.id);
  const at = l.tt.lastEventAt || null;
  try{
    const state = await window.crmFirebase.getLeadTailorTalk(l.id);
    ttStateCache.set(l.id, { at, state: state || null, error: null });
  } catch(e){
    console.error('loadTtState failed:', e);
    ttStateCache.set(l.id, { at, state: null, error: e && e.code==='permission-denied' ? 'rules' : 'load' });
  } finally {
    ttStateLoading.delete(l.id);
    const cur = leads.find(x=>x.id===l.id);
    if(cur && currentDetailId===l.id && document.getElementById('dp').classList.contains('open')){ renderTtSection(cur); renderTimeline(cur); }
  }
}

function setTtTab(tab){
  ttTab = tab === 'conversation' ? 'conversation' : 'overview';
  try{ localStorage.setItem(TT_TAB_KEY, tab); }catch(e){}
  const l = leads.find(x=>x.id===currentDetailId);
  if(l) renderTtSection(l);
}

function wonStage(){
  return stages.find(s=>s.id==='closed_won') || stages.find(s=>/won/i.test(s.name||'')) || null;
}
function lostStage(){
  return stages.find(s=>s.id==='closed_lost') || stages.find(s=>/lost/i.test(s.name||'')) || null;
}
// A signal's suggested stage, found by the default id first and then by name, so a renamed or
// re-created pipeline still resolves ("Site Visit", "Negotiation", "Closed Lost").
const TT_STAGE_FINDERS = {
  site_visit:  () => stages.find(s=>s.id==='site_visit') || stages.find(s=>/visit/i.test(s.name||'')) || null,
  negotiation: () => stages.find(s=>s.id==='negotiation') || stages.find(s=>/negotiat/i.test(s.name||'')) || null,
  closed_lost: () => lostStage()
};
function moveTtLeadToStage(id, stageId){
  const l = leads.find(x=>x.id===id);
  const stage = stageById(stageId);
  if(!l || !stage) return;
  if(!confirm(`Move ${l.name} to "${stage.name}"?`)) return;
  changeStage(id, stage.id);
  showToast(`Moved to ${stage.name}`);
  renderTtSection(l);
}
function moveTtLeadToWon(id){
  const l = leads.find(x=>x.id===id);
  const won = wonStage();
  if(!l || !won) return;
  if(!confirm(`TailorTalk marked ${l.name} as converted. Move this lead to "${won.name}"?`)) return;
  changeStage(id, won.id);
  showToast(`✓ Moved to ${won.name}`);
  renderTtSection(l);
}
// Clears everything open on the lead (signals, a new escalation, a message waiting for the team)
// in one logged step, for when reading it was the whole job.
const TT_ALERT_TITLES = { escalated:'New escalation', flagged:'New flag', waiting:'Message waiting for the team' };
// (markTtHandled lived here: a second, unreferenced copy of markHandledUi that
// wrote the identical "Handled: <x>" line. One action must have exactly one
// place that records it, or the history stops being trustworthy.)
function markTtDetailsSent(id){
  if(currentDetailId!==id) openDetail(id);
  setDetailsSent(true);
  const l = leads.find(x=>x.id===id);
  if(l){ refreshAll(); renderTtSection(l); }
  showToast('✓ Details marked as sent');
}

// The team edited a field TailorTalk used to keep current; this hands it back.
async function useTailorTalkValue(id, field){
  const l = leads.find(x=>x.id===id);
  if(!isTtLead(l) || !l.tt.values || !l.tt.values[field]) return;
  const value = l.tt.values[field];
  const label = TT_FIELD_LABELS[field];
  if(!confirm(`Change ${label} to "${value}" and let TailorTalk keep it up to date from now on?`)) return;
  try{
    await window.crmFirebase.releaseLeadField(id, field, value);
  } catch(e){
    showToast('Could not update — check your connection');
    return;
  }
  addHistory(l, 'field', `${escapeHtml(label)} changed from <b>${escapeHtml(l[field]||'—')}</b> to <b>${escapeHtml(value)}</b> — TailorTalk keeps it up to date again`);
  l[field] = value;
  l.ttHold = { ...(l.ttHold||{}), [field]: false };
  l.updatedAt = Date.now();
  l.updatedBy = currentUserEmail || l.updatedBy || null;
  l.lastActionType = 'field';
  persistLead(l);
  refreshAll();
  if(currentDetailId===id){ renderDetailInfo(l); renderTtSection(l); renderHistory(l); }
  showToast(`✓ ${label} now follows TailorTalk`);
}

function ttStat(label, value, sub, cls){
  return `<div class="tt-stat${cls?' '+cls:''}"><div class="tt-stat-l">${label}</div><div class="tt-stat-v">${value}</div>${sub?`<div class="tt-stat-s">${sub}</div>`:''}</div>`;
}
function fmtWhen(ts){
  return new Date(ts).toLocaleString([], { month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' });
}
function fmtClock(ts){ return new Date(ts).toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' }); }
function fmtDay(ts){ return new Date(ts).toLocaleDateString([], { weekday:'short', day:'numeric', month:'short' }); }
function dayKeyOf(ts){ const d = new Date(ts); return `${d.getFullYear()}-${pad2(d.getMonth()+1)}-${pad2(d.getDate())}`; }
function relDay(ts){
  const today = dayKeyOf(Date.now()), y = dayKeyOf(Date.now() - 86400000), k = dayKeyOf(ts);
  if(k===today) return 'Today';
  if(k===y) return 'Yesterday';
  return timeAgo(new Date(ts).setHours(12,0,0,0));
}
function gapWords(ms){
  const h = Math.round(ms/3600000);
  if(h < 48) return `${h} hours`;
  return `${Math.round(ms/86400000)} days`;
}
function prettyKey(k){
  return String(k).replace(/_/g,' ').replace(/\b\w/g, c=>c.toUpperCase());
}

// ── Chat days: one entry per day, from the stored conversation plus TailorTalk's history ──
// Nothing here is stored — it is recomputed from what the lead page already loaded, so it
// cannot drift from the conversation and costs no writes. The Timeline draws it (ttDayItems).
function ttActivityDays(l, st){
  const days = new Map();
  const dayFor = ts => {
    const k = dayKeyOf(ts);
    if(!days.has(k)) days.set(k, { key:k, first:ts, last:ts, lead:0, ai:0, team:0, followups:0, left:[], cameBackAfter:null, quote:null, events:[] });
    const d = days.get(k);
    d.first = Math.min(d.first, ts); d.last = Math.max(d.last, ts);
    return d;
  };
  let prev = null;
  ((st && st.chat) || []).forEach(m => {
    if(!m.at) return;
    const d = dayFor(m.at);
    if(isNoReplyMarker(m)){ d.left.push(m.at); return; }
    if(m.role==='user'){
      if(!d.lead && prev && m.at - prev.at > TT_RETURN_GAP_MS) d.cameBackAfter = m.at - prev.at;
      d.lead++;
      if(!d.quote && m.content) d.quote = m.content;
    } else if(m.role==='human_agent'){
      d.team++;
    } else {
      d.ai++;
      if(prev && prev.role!=='user' && m.at - prev.at > TT_FOLLOWUP_GAP_MS) d.followups++;
    }
    prev = m;
  });
  (l.history || []).filter(h => h.by==='TailorTalk' && h.at).forEach(h => dayFor(h.at).events.push(h));
  Object.entries((l.tt && l.tt.signals) || {}).forEach(([key, s]) => { if(s && s.at) dayFor(s.at).events.push({ at:s.at, signal:key, quote:ttSignalQuote(key, s) }); });
  return Array.from(days.values()).sort((a,b) => b.first - a.first);
}

function ttOverviewHtml(l, st){
  const t = l.tt;
  const cards = TT_PROFILE.filter(([k]) => st.profile && st.profile[k] && !(k==='flag_details' && t.flagged))
    .map(([k, label]) => `<div class="tt-card"><div class="tt-stat-l">${label}</div><div class="tt-card-v">${escapeHtml(st.profile[k])}</div></div>`);
  Object.entries(st.extra || {}).forEach(([k, v]) => {
    cards.push(`<div class="tt-card"><div class="tt-stat-l">${escapeHtml(prettyKey(k))}</div><div class="tt-card-v">${escapeHtml(String(v))}</div></div>`);
  });
  let html = cards.length ? `<div class="tt-profile">${cards.join('')}</div>` : '<div class="empty-mini">TailorTalk hasn\'t written a profile for this lead yet.</div>';
  const bookings = (st.bookings || []).slice().sort((a,b)=>(b.start||0)-(a.start||0));
  if(bookings.length){
    html += `<div class="tt-sub">Bookings</div><div class="tt-list">${bookings.map(b => `
      <div class="tt-item"><span><b>${escapeHtml(b.summary || 'Booking')}</b>${b.minutes?` · ${b.minutes} min`:''}${b.link?` · <a href="${escapeHtml(b.link)}" target="_blank" rel="noopener">Meeting link</a>`:''}</span><span class="tt-when">${b.start?fmtWhen(b.start):'—'}</span></div>`).join('')}</div>`;
  }
  const payments = (st.payments || []).slice().sort((a,b)=>(b.at||0)-(a.at||0));
  if(payments.length){
    html += `<div class="tt-sub">Payments</div><div class="tt-list">${payments.map(p => `
      <div class="tt-item"><span><b>${p.amount!=null ? (p.currency==='INR'?'₹':escapeHtml(p.currency)+' ')+Number(p.amount).toLocaleString('en-IN') : 'Payment'}</b> · ${escapeHtml(p.id)}</span><span class="tt-when">${p.at?fmtWhen(p.at):'—'}</span></div>`).join('')}</div>`;
  }
  return html;
}

function ttConversationHtml(l, st){
  const chat = st.chat || [];
  if(!chat.length) return '<div class="empty-mini">No messages stored yet.</div>';
  const expanded = ttChatExpanded.has(l.id);
  const shown = expanded ? chat : chat.slice(-TT_CHAT_PAGE);
  const hiddenCount = chat.length - shown.length;
  const who = m => m.role==='user' ? escapeHtml(l.name || 'Lead') : m.role==='assistant' ? 'AI agent' : ('Team' + (m.email ? ' · '+escapeHtml(m.email.split('@')[0]) : ''));
  let lastDay = null;
  const body = shown.map(m => {
    let sep = '';
    const k = m.at ? dayKeyOf(m.at) : null;
    if(k && k!==lastDay){ sep = `<div class="tt-chat-day"><span>${fmtDay(m.at)}</span></div>`; lastDay = k; }
    if(isNoReplyMarker(m)) return `${sep}<div class="tt-chat-sys">AI didn’t reply — left for the team${m.at?' · '+fmtClock(m.at):''}</div>`;
    const cls = m.role==='user' ? 'user' : m.role==='assistant' ? 'assistant' : 'team';
    return `${sep}<div class="tt-msg ${cls}"><div class="tt-msg-meta">${who(m)}${m.at?' · '+fmtClock(m.at):''}</div><div class="tt-msg-text">${escapeHtml(m.content || (m.meta && m.meta.type ? '['+m.meta.type+']' : ''))}</div></div>`;
  }).join('');
  const more = hiddenCount > 0
    ? `<button type="button" class="tt-btn tt-chat-more" onclick="ttChatExpanded.add('${l.id}');renderTtSection(leads.find(x=>x.id==='${l.id}'))">Show ${hiddenCount} earlier message${hiddenCount===1?'':'s'}</button>`
    : (st.chatTruncated ? '<div class="tt-foot tt-chat-more">Older messages were too long to keep.</div>' : '');
  return `<div class="tt-chat" id="dpTtChatScroll">${more}${body}</div>
    <div class="tt-foot">Reply from TailorTalk’s inbox — your reply appears here with TailorTalk’s next update.</div>`;
}

// ═══════ CONVERSATION PANE ═══════
// On a wide screen the chat belongs BESIDE the lead, not buried under a tab:
// reading what was said while editing the record is the whole job. Below
// DP_SPLIT_MIN there is no room for two columns, so it becomes a sheet that
// takes the screen instead — a toggle, not a squeeze.
const DP_SPLIT_MIN = 1100;
const DP_SIDE_KEY = 'crmDpSideW';
const DP_PANE_KEY = 'crmConvPane';
let convPaneOpen = true;       // wide-screen preference, remembered
let convSheetOpen = false;     // narrow-screen, this viewing only
try{ convPaneOpen = localStorage.getItem(DP_PANE_KEY) !== 'off'; }catch(e){}

function dpIsWide(){ return window.innerWidth >= DP_SPLIT_MIN; }
function conversationPaneActive(){
  const l = currentDetailId ? leads.find(x => x.id === currentDetailId) : null;
  if(!l || !isTtLead(l)) return false;
  return dpIsWide() ? convPaneOpen : convSheetOpen;
}
function toggleConversationPane(){
  if(dpIsWide()){
    convPaneOpen = !convPaneOpen;
    try{ localStorage.setItem(DP_PANE_KEY, convPaneOpen ? 'on' : 'off'); }catch(e){}
  } else {
    convSheetOpen = !convSheetOpen;
  }
  syncConversationPane();
  // Re-render so the inline tab set picks the conversation back up when the
  // pane gives it away, and drops it when the pane takes it.
  const l = currentDetailId ? leads.find(x => x.id === currentDetailId) : null;
  if(l) renderTtSection(l);
}
function syncConversationPane(){
  const split = document.getElementById('dpSplit');
  const btn = document.getElementById('dpConvBtn');
  if(!split) return;
  const l = currentDetailId ? leads.find(x => x.id === currentDetailId) : null;
  const has = !!(l && isTtLead(l));
  if(btn){
    btn.hidden = !has;
    btn.setAttribute('aria-pressed', has && conversationPaneActive() ? 'true' : 'false');
  }
  const on = has && conversationPaneActive();
  split.classList.toggle('split', on && dpIsWide());
  split.classList.toggle('sheet', on && !dpIsWide());
  if(on) renderConversationPane(l);
  else { const b = document.getElementById('dpSideBody'); if(b) b.innerHTML = ''; }
}
function renderConversationPane(l){
  const box = document.getElementById('dpSideBody');
  if(!box) return;
  const cached = ttStateCache.get(l.id);
  const st = cached && cached.state;
  if(!cached) box.innerHTML = '<div class="empty-mini">Loading the conversation…</div>';
  else if(cached.error === 'rules') box.innerHTML = '<div class="empty-mini">The conversation can\'t be read — the Firestore rules need updating.</div>';
  else if(cached.error) box.innerHTML = '<div class="empty-mini">Couldn\'t load the conversation — check your connection.</div>';
  else if(!st) box.innerHTML = '<div class="empty-mini">No conversation yet — it arrives with the next update.</div>';
  else box.innerHTML = ttConversationHtml(l, st);
  scrollConversationToLatest(l);
}

// In the side pane the pane itself scrolls; inline it is the chat box. Scroll
// whichever one actually has the overflow, or the newest message — the reason
// the panel is open — sits below the fold every time.
function scrollConversationToLatest(l){
  if(l && ttChatExpanded.has(l.id)) return;   // they went looking for history
  requestAnimationFrame(() => {
    const chat = document.getElementById('dpTtChatScroll');
    if(!chat) return;
    const pane = chat.closest('#dpSideBody');
    const sc = (pane && pane.scrollHeight > pane.clientHeight + 4) ? pane
             : (chat.scrollHeight > chat.clientHeight + 4) ? chat : null;
    if(sc) sc.scrollTop = sc.scrollHeight;
  });
}

// ── The draggable divider ──
function initDpResizer(){
  const rz = document.getElementById('dpResizer');
  const split = document.getElementById('dpSplit');
  if(!rz || !split || rz.dataset.wired) return;
  rz.dataset.wired = '1';

  let stored = null;
  try{ stored = parseFloat(localStorage.getItem(DP_SIDE_KEY)); }catch(e){}
  const apply = pct => {
    // Clamped so neither side can be dragged away to nothing.
    const v = Math.min(62, Math.max(22, pct));
    document.documentElement.style.setProperty('--dp-side-w', v + '%');
    rz.setAttribute('aria-valuenow', Math.round(v));
    try{ localStorage.setItem(DP_SIDE_KEY, String(v)); }catch(e){}
    return v;
  };
  apply(isFinite(stored) ? stored : 34);

  const pctFromX = x => {
    const r = split.getBoundingClientRect();
    return (1 - (x - r.left) / r.width) * 100;
  };
  const onMove = e => {
    const x = e.touches ? e.touches[0].clientX : e.clientX;
    apply(pctFromX(x));
  };
  const stop = () => {
    rz.classList.remove('dragging');
    document.body.classList.remove('dp-resizing');
    removeEventListener('mousemove', onMove);
    removeEventListener('touchmove', onMove);
    removeEventListener('mouseup', stop);
    removeEventListener('touchend', stop);
  };
  const start = e => {
    e.preventDefault();
    rz.classList.add('dragging');
    document.body.classList.add('dp-resizing');
    addEventListener('mousemove', onMove);
    addEventListener('touchmove', onMove, { passive:false });
    addEventListener('mouseup', stop);
    addEventListener('touchend', stop);
  };
  rz.addEventListener('mousedown', start);
  rz.addEventListener('touchstart', start, { passive:false });
  // A divider that can only be dragged is a divider a keyboard cannot move.
  rz.addEventListener('keydown', e => {
    const step = e.shiftKey ? 8 : 2;
    if(e.key === 'ArrowLeft'){ e.preventDefault(); apply(parseFloat(rz.getAttribute('aria-valuenow')) + step); }
    else if(e.key === 'ArrowRight'){ e.preventDefault(); apply(parseFloat(rz.getAttribute('aria-valuenow')) - step); }
    else if(e.key === 'Home'){ e.preventDefault(); apply(34); }
  });
  // Double-click restores the default split, the usual escape hatch from a
  // divider dragged somewhere unhelpful.
  rz.addEventListener('dblclick', () => apply(34));
}
// Crossing the breakpoint has to re-decide between split and sheet.
addEventListener('resize', () => { if(currentDetailId) syncConversationPane(); });

function renderTtSection(l){
  const sec = document.getElementById('dpTtSec');
  if(!sec) return;
  if(!isTtLead(l)){ sec.hidden = true; return; }
  sec.hidden = false;

  const t = l.tt;
  const cached = ttStateCache.get(l.id);
  const st = cached && cached.state;

  // What needs a person is listed once, in "Where this lead stands" above (renderStandSection).

  // 2. Fields the team took over, where TailorTalk has since heard something different.
  const says = TT_FOLLOW_FIELDS.filter(f => l.ttHold && l.ttHold[f] && t.values && t.values[f] && t.values[f] !== (l[f]||''))
    .map(f => `<div class="tt-says"><span>TailorTalk now says <b>${escapeHtml(TT_FIELD_LABELS[f].toLowerCase())}</b>: <b>${escapeHtml(t.values[f])}</b> · you have <b>${escapeHtml(l[f]||'—')}</b></span><button type="button" class="tt-btn" onclick="useTailorTalkValue('${l.id}','${f}')">Use TailorTalk's value</button></div>`)
    .join('');

  // 3. The lead at a glance.
  const stats = [];
  const s = TT_STATUS[t.status];
  stats.push(ttStat('Status', s ? `${s.icon} ${s.label}` : (t.status ? escapeHtml(ttStatusLabel(t.status)) : '—'), t.statusAt ? 'since '+timeAgo(t.statusAt) : ''));
  if(t.lastMessageAt){
    let windowNote = '';
    if(l.channel==='whatsapp' || t.integration==='whatsapp'){
      const left = t.lastMessageAt + TT_WINDOW_MS - Date.now();
      windowNote = left > 0 ? `Reply window open · ${relativeFollowUpText(Date.now()+left).replace(/^In /,'')} left` : 'Reply window closed — template needed';
    }
    stats.push(ttStat('Last message', timeAgo(t.lastMessageAt) + (t.lastSeen===false ? ' · <span class="tt-unread">unread</span>' : ''), windowNote));
  }
  stats.push(ttStat('AI', t.locked ? '🔒 Paused' : '🤖 Replying', t.followups ? `${t.followups} follow-up${t.followups===1?'':'s'} sent` : ''));
  const origin = ttSourceLabel(t.leadSource) || channelLabel(l.channel);
  const ad = t.adTitle ? (t.adUrl ? `<a href="${escapeHtml(t.adUrl)}" target="_blank" rel="noopener">${escapeHtml(t.adTitle)}</a>` : escapeHtml(t.adTitle)) : '';
  stats.push(ttStat('Came from', escapeHtml(origin || '—'), ad || (t.createdAt ? 'first message '+fmtDay(t.createdAt) : '')));
  if(t.converted){
    const won = wonStage();
    const btn = won && l.stageId!==won.id ? `<button type="button" class="tt-btn" onclick="moveTtLeadToWon('${l.id}')">Move to ${escapeHtml(won.name)}</button>` : '';
    stats.push(ttStat('Converted', '✅ Yes', (t.convertedAt ? fmtWhen(t.convertedAt) : '') + btn, 'good'));
  }
  if(t.escalated && !ttOpenAlerts(l).some(a=>a.key==='escalated')) stats.push(ttStat('Escalated', escapeHtml(t.escalatedTo || 'Yes'), t.escalatedAt ? fmtWhen(t.escalatedAt) : 'before it reached the CRM'));
  if(t.flagged && !ttOpenAlerts(l).some(a=>a.key==='flagged')) stats.push(ttStat('Flagged', escapeHtml(t.flagDetails || 'Yes')));
  if(t.owner) stats.push(ttStat('TailorTalk owner', escapeHtml(t.owner)));

  // 4. Overview · Conversation (the day-by-day summary is in the Timeline).
  // While the side pane owns the conversation, showing it here as well would
  // put the same chat on screen twice.
  const paneHasChat = conversationPaneActive();
  const tab2 = paneHasChat ? 'overview' : ttTab;
  let panel;
  if(!cached) panel = '<div class="empty-mini">Loading TailorTalk details…</div>';
  else if(cached.error==='rules') panel = '<div class="empty-mini">TailorTalk details can\'t be read — the Firestore rules need updating.</div>';
  else if(cached.error) panel = '<div class="empty-mini">Couldn\'t load TailorTalk details — check your connection.</div>';
  else if(!st) panel = '<div class="empty-mini">No TailorTalk details yet — they arrive with the next update.</div>';
  else panel = tab2==='conversation' ? ttConversationHtml(l, st) : ttOverviewHtml(l, st);

  const msgCount = st && st.chat ? st.chat.filter(m => !isNoReplyMarker(m)).length : null;
  const tab = (key, label, n) => `<button type="button" role="tab" class="tt-tab${tab2===key?' at':''}" aria-selected="${tab2===key}" onclick="setTtTab('${key}')">${label}${n!=null?`<span class="tt-tab-n">${n}</span>`:''}</button>`;
  const tabs = paneHasChat
    ? `<div class="tt-tabs" role="tablist">${tab('overview','Overview')}</div>`
    : `<div class="tt-tabs" role="tablist">${tab('overview','Overview')}${tab('conversation','Conversation', msgCount)}</div>`;

  document.getElementById('dpTt').innerHTML = `
    ${says}
    <div class="tt-strip">${stats.join('')}</div>
    ${tabs}
    <div class="tt-panel" role="tabpanel">${panel}</div>
    <div class="tt-foot">Last change from TailorTalk ${timeAgo(t.syncedAt || t.lastEventAt)}</div>`;
  if(tab2==='conversation') scrollConversationToLatest(l);
  // Data arrives async, so the pane is refreshed from the same place the
  // inline section is — never left showing "Loading…" after the chat lands.
  if(paneHasChat) renderConversationPane(l);
}

// ═══════ NAV: view switching, more menu ═══════
//
// Which view is showing is the rail's job to display — the four buttons and
// the Board/List dropdown that used to live in the header are entries in it
// now. toggleView only has to show the right pane and tell the rail.
const CRM_VIEWS = ['today', 'kanban', 'list', 'followups', 'dashboard'];
function toggleView(view){
  currentView = view;
  if(view==='kanban' || view==='list') lastBrowseView = view;
  updateNavState();
  CRM_VIEWS.forEach(v=>{
    const el = document.getElementById(v==='kanban' ? 'kanbanView' : v+'View');
    if(el) el.style.display = view===v ? '' : 'none';
  });
  if(view==='dashboard'){ if(window.renderDashboardView) window.renderDashboardView(); }
  else if(view==='today'){ if(window.renderTodayView) window.renderTodayView(); }
  else applyFilters();
}
function updateNavState(){
  if(window.AppNav) window.AppNav.setActive(currentView);
  // Search and the filter chips act on a list of leads. Daily task is a list
  // of today, so they have nothing to act on there and only get in the way.
  const isLeadList = currentView !== 'today';
  document.querySelector('.srch-wrap').style.display = isLeadList ? '' : 'none';
  document.querySelector('.lf-row').style.display = isLeadList ? '' : 'none';
}
// A trigger that claims aria-expanded="false" while its menu is open is worse
// than one that says nothing, so every path that opens or closes a menu ends
// here rather than each setting the attribute itself.
function syncDropdownAria(){
  const dd = document.getElementById('moreDd');
  const btn = dd && dd.querySelector('.menu-btn');
  if(btn) btn.setAttribute('aria-expanded', dd.classList.contains('open') ? 'true' : 'false');
}
function toggleMoreMenu(e){
  if(e) e.stopPropagation();
  document.getElementById('moreDd').classList.toggle('open');
  syncDropdownAria();
}
function closeMoreMenu(){
  document.getElementById('moreDd').classList.remove('open');
  syncDropdownAria();
}
document.addEventListener('click', ()=>{ closeMoreMenu(); closePropertyPop(); });

// ═══════ HELPERS ═══════
function stageById(id){ return stages.find(s=>s.id===id); }
function nextStageId(id){
  const idx = stages.findIndex(s=>s.id===id);
  if(idx===-1 || idx===stages.length-1) return null;
  return stages[idx+1].id;
}
function timeAgo(ts){
  if(!ts) return '—';
  const diff = Date.now()-ts;
  const mins = Math.floor(diff/60000);
  if(mins<1) return 'just now';
  if(mins<60) return mins+'m ago';
  const hrs = Math.floor(mins/60);
  if(hrs<24) return hrs+'h ago';
  const days = Math.floor(hrs/24);
  return days+'d ago';
}
function pad2(n){ return String(n).padStart(2,'0'); }
function toDateInputValue(d){ return `${d.getFullYear()}-${pad2(d.getMonth()+1)}-${pad2(d.getDate())}`; }
function toTimeInputValue(d){ return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`; }
function followUpBadge(l){
  if(!l.followUpAt) return '';
  const diff = l.followUpAt - Date.now();
  const cls = diff < 0 ? 'overdue' : (diff < 24*60*60*1000 ? 'soon' : '');
  const when = new Date(l.followUpAt).toLocaleString([], { month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' });
  return `<div class="lcard-followup ${cls}">📅 ${diff<0?'Overdue: ':''}${when}</div>`;
}

// ═══════ PERSIST + AI SUMMARY ═══════
// Single choke point for every lead write — every call site that used to
// call window.crmFirebase.saveLead(l) directly now goes through here, so a
// summary regeneration can never be forgotten on some new call site later.
function persistLead(l){
  window.crmFirebase.saveLead(l);
  // Any team action closes the lead's open TailorTalk signals (see ttOpenSignals) — redraw
  // them now rather than when the snapshot comes back.
  if(currentDetailId===l.id && isTtLead(l) && document.getElementById('dp').classList.contains('open')) renderTtSection(l);
}

// Add a note to a lead: update the in-memory arrays + denormalized lastNote/
// noteCount (what the board & follow-ups render), and persist the note as its
// own doc in the lead's notes subcollection. Callers still call persistLead(l)
// afterwards to save the small parent (lastNote/noteCount/updatedAt/…).
// Assumes the parent lead doc already exists (true everywhere except the very
// first write of a brand-new lead, which creates the parent first — see the
// add-lead path in saveLeadModal).
function logNote(l, note){
  l.notes = l.notes || [];
  l.notes.push(note);
  l.noteCount = l.notes.length;
  l.lastNote = { text: note.text, createdAt: note.createdAt, by: note.by || null };
  if(window.crmFirebase && window.crmFirebase.saveNote) window.crmFirebase.saveNote(l.id, note);
}
function recomputeNoteMeta(l){
  const notes = (l.notes || []).slice().sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  const last = notes[notes.length - 1] || null;
  l.noteCount = notes.length;
  l.lastNote = last ? { text: last.text, createdAt: last.createdAt, by: last.by || null } : null;
}

// AI summaries are generated ON DEMAND only — the agent clicks "🔄 Regenerate"
// in the lead's summary box. Previously EVERY lead save auto-fired a debounced
// Claude call, so a single workflow (drag stage → add note → edit a field)
// silently cost 3 generations with no explicit intent. On-demand generation
// removes that cost leak entirely and also drops the extra summary write.
const summaryGeneratingIds = new Set();
function renderAiSummary(l){
  const el = document.getElementById('dpAiSummary');
  if(!el) return;
  const generating = summaryGeneratingIds.has(l.id);
  const btn = `<button class="dp-ai-regen" ${generating?'disabled':''} onclick="regenerateSummaryNow('${l.id}')">${generating?'⏳ Generating…':'🔄 Regenerate'}</button>`;
  if(!l.aiSummary && !l.aiSummaryError){
    el.innerHTML = `<div class="dp-ai-summary-box empty"><div class="dp-ai-summary-meta">✨ AI summary ${btn}</div><div class="dp-ai-summary-text empty">${generating?'Generating summary…':'No AI summary yet — tap Regenerate to create one.'}</div></div>`;
    return;
  }
  const metaHtml = `<div class="dp-ai-summary-meta">✨ AI summary${l.aiSummaryAt?' · updated '+timeAgo(l.aiSummaryAt):''} ${btn}</div>`;
  const summaryHtml = l.aiSummary
    ? `<div class="dp-ai-summary-text">${escapeHtml(l.aiSummary)}</div>`
    : `<div class="dp-ai-summary-text empty">${generating?'Generating summary…':'No summary yet.'}</div>`;
  const errorHtml = l.aiSummaryError
    ? `<div class="dp-ai-summary-err">⚠ Couldn't refresh the summary — showing the last one. (${escapeHtml(l.aiSummaryError)})</div>`
    : '';
  el.innerHTML = `<div class="dp-ai-summary-box${l.aiSummaryError?' has-error':''}">${metaHtml}${summaryHtml}${errorHtml}</div>`;
}
// The new summary lands back through the normal Firestore onSnapshot listener
// (applyLeadsSnapshot), which re-renders this block — we only manage the
// transient "generating" spinner state here.
async function regenerateSummaryNow(leadId){
  if(summaryGeneratingIds.has(leadId)) return;
  summaryGeneratingIds.add(leadId);
  const l = leads.find(x=>x.id===leadId);
  if(l && currentDetailId===leadId) renderAiSummary(l);
  try{
    const idToken = await window.crmAuth.getIdToken();
    if(!idToken){ showToast('Please log in again'); return; }
    const res = await fetch('/api/lead-summary?op=generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer '+idToken },
      body: JSON.stringify({ leadId })
    });
    if(!res.ok){
      const e = await res.json().catch(()=>({}));
      showToast(e.error ? 'Summary failed: '+e.error : 'Summary failed');
    }
  } catch(e){
    console.error('regenerateSummaryNow failed:', e);
    showToast('Summary failed — check your connection');
  } finally {
    summaryGeneratingIds.delete(leadId);
    const cur = leads.find(x=>x.id===leadId);
    if(cur && currentDetailId===leadId) renderAiSummary(cur);
  }
}

// One-time (re-runnable) bulk fill for existing leads that don't have an AI
// summary yet. The server processes only a few leads per request (to stay
// well under the function time limit), returning a cursor + `done`; we loop
// here, walking the cursor until every lead is covered, so this scales to any
// number of leads without a timeout. Results land back through the usual
// Firestore listener.
let backfillRunning = false;
async function runBackfillSummaries(){
  if(backfillRunning) return;
  if(!confirm('Generate AI summaries for every existing lead that doesn\'t have one yet? This calls the Claude API once per lead.')) return;
  closeMoreMenu();
  backfillRunning = true;
  let cursor = null, generated = 0, failed = 0, safety = 0;
  const allErrors = [];
  try{
    while(safety++ < 1000){
      const idToken = await window.crmAuth.getIdToken();
      if(!idToken){ showToast('Please log in again'); break; }
      const res = await fetch('/api/lead-summary?op=backfill', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer '+idToken },
        body: JSON.stringify(cursor ? { cursor } : {})
      });
      const data = await res.json().catch(()=>({}));
      if(!res.ok){ showToast(data.error || 'Backfill failed'); break; }
      generated += data.generated || 0;
      failed += data.failed || 0;
      if(data.errors && data.errors.length) allErrors.push(...data.errors);
      cursor = data.cursor;
      showToast(`Generating summaries… ${generated} done${data.remaining>0?`, ${data.remaining}+ to go`:''}`);
      if(data.done) break;
    }
    showToast(failed
      ? `✓ Generated ${generated}, ${failed} failed — check console`
      : (generated ? `✓ Generated summaries for ${generated} lead${generated===1?'':'s'}` : 'All leads already have a summary'));
    if(allErrors.length) console.error('Backfill errors:', allErrors);
  } catch(e){
    console.error('runBackfillSummaries failed:', e);
    showToast('Backfill failed — check console');
  } finally {
    backfillRunning = false;
  }
}

// ═══════ LEAD HISTORY LOG ═══════
// text may contain <b> tags around already-escaped values for emphasis —
// never pass raw user input directly, always escapeHtml() it first.
function addHistory(l, type, text){
  l.history = l.history || [];
  const now = Date.now();
  // A double tap writes the line twice. It is easy to do on a phone, and every
  // one of these buttons re-renders under the finger, so the second tap lands
  // on a freshly drawn button rather than being swallowed. The same event with
  // the same text moments apart is never two things that happened — it is one
  // thing recorded twice. Guarded here rather than per button so every path
  // into the timeline gets it: Handled, Followed up, stage moves, the lot.
  const recent = l.history.find(h => h && h.type === type && h.text === text && now - (h.at || 0) < 8000);
  if(recent) return recent;
  const event = {
    id: 'h'+now+Math.random().toString(36).slice(2,7),
    type, text,
    at: now,
    by: currentUserEmail || l.updatedBy || null
  };
  l.history.push(event);
  // Persist to the lead's history subcollection (instead of rewriting a
  // growing array on the parent). Assumes the parent lead doc exists — true
  // for every flow except the brand-new-lead path, which creates the parent
  // first and only then logs its 'created' event.
  if(window.crmFirebase && window.crmFirebase.saveHistory) window.crmFirebase.saveHistory(l.id, event);
  return event;
}
function historyIcon(type){
  return { created:'✨', stage:'🔀', field:'✏️', followup:'📅', 'followup-removed':'🗑️', 'followed-up':'✓', 'details-sent':'📨', tailortalk:'💬' }[type] || '•';
}

// ═══════ TIMELINE — everything that happened to a lead, in one feed ═══════
// Notes, stage moves, follow-ups, the AI's moves, TailorTalk (a one-line summary per chat day plus
// its updates) and edits, newest first, grouped by day, with a filter per kind. Nothing is stored
// for it: it is drawn from the notes, history and conversation the lead page already loaded.
const TL_FILTERS = [
  { key:'all', label:'All' }, { key:'notes', label:'Notes' }, { key:'stage', label:'Stage' },
  { key:'followups', label:'Follow-ups' }, { key:'ai', label:'AI' }, { key:'tailortalk', label:'TailorTalk' }, { key:'edits', label:'Edits' }
];
const TL_FILTER_KEY = 'crmTimelineFilter';
const TL_PAGE = 40;
let tlFilter = 'all';
try{ const f = localStorage.getItem(TL_FILTER_KEY); if(TL_FILTERS.some(x => x.key === f)) tlFilter = f; }catch(e){}
const tlExpanded = new Set();

// Every row says what kind of event it is, in words. Before this the only
// identification was a 12px emoji in a circle — and TailorTalk used the same
// 💬 for a stage change, a paused AI and a day's messages, so three different
// kinds of thing were indistinguishable until you read all of them.
// Order matters: an AI stage move is tagged both 'ai' and 'stage', and "AI" is
// the more useful of the two to lead with.
const TL_KIND_ORDER = ['notes', 'ai', 'tailortalk', 'stage', 'followups', 'edits'];
const TL_KIND_LABEL = { notes:'Note', ai:'AI', tailortalk:'TailorTalk', stage:'Stage', followups:'Follow-up', edits:'Edit' };
function timelineKind(item){
  const key = TL_KIND_ORDER.find(k => item.tags.includes(k));
  return { key: key || 'edits', label: TL_KIND_LABEL[key] || 'Event' };
}

function historyTags(h){
  const text = String(h.text || '');
  const tags = [];
  if(h.by === 'AI' || text.startsWith('🤖')) tags.push('ai');
  if(h.by === 'TailorTalk' || h.type === 'tailortalk') tags.push('tailortalk');
  if(h.type === 'stage') tags.push('stage');
  if(h.type === 'followup' || h.type === 'followup-removed' || h.type === 'followed-up') tags.push('followups');
  if(!tags.length) tags.push('edits');
  return tags;
}
// TailorTalk's conversation, one line per day (the chat itself stays in the Conversation tab).
function ttDayItems(l){
  const cached = ttStateCache.get(l.id);
  const st = cached && cached.state;
  if(!isTtLead(l) || !st) return [];
  const where = { whatsapp:'WhatsApp', instagram:'Instagram', web:'Website chat', website:'Website chat' }[(l.tt && l.tt.integration) || l.channel] || 'Chat';
  return ttActivityDays(l, st).map(d => {
    const parts = [];
    const msgs = d.lead + d.ai + d.team;
    if(msgs) parts.push(`<b>${msgs} message${msgs===1?'':'s'}</b> — ${d.lead} from the lead, ${d.ai} AI${d.team ? `, ${d.team} team` : ''} <span class="tl-t">${fmtClock(d.first)}${d.last!==d.first ? '–'+fmtClock(d.last) : ''}</span>`);
    if(d.cameBackAfter) parts.push(`<span class="tl-good">came back after ${gapWords(d.cameBackAfter)}</span>`);
    if(d.followups) parts.push(`${d.followups} AI follow-up${d.followups===1?'':'s'}`);
    if(d.left.length) parts.push(`<span class="tl-warn">${d.left.length} message${d.left.length===1?'':'s'} left for the team</span>`);
    d.events.filter(e => e.signal).forEach(e => { const m = ttSignalMeta(e.signal); parts.push(`<span class="tl-warn">${m.icon} ${escapeHtml(m.title)}${e.quote ? ` — “${escapeHtml(e.quote)}”` : ''}</span>`); });
    if(!parts.length) return null;
    const quote = d.quote ? `<div class="tl-quote">“${escapeHtml(d.quote.length > 160 ? d.quote.slice(0,159)+'…' : d.quote)}”</div>` : '';
    return { tags:['tailortalk'], at: d.last, icon:'💬', html: `${where}: ${parts.join(' · ')}${quote}`, by: null, summary: true };
  }).filter(Boolean);
}
function timelineItems(l){
  return [
    ...(l.notes || []).map(n => ({ tags:['notes'], at: n.createdAt || 0, icon:'📝', html: `<div class="tl-note">${noteTextHtml(n.text)}</div>`, by: n.by, noteId: n.id })),
    ...(l.history || []).map(h => ({ tags: historyTags(h), at: h.at || 0, icon: historyIcon(h.type), html: h.text || '', by: h.by })),
    ...ttDayItems(l)
  ].sort((a, b) => b.at - a.at);
}
function noteTextHtml(text){ return mentionifyHtml(escapeHtml(text || '')); }

// One action can still legitimately write more than one line — moving a lead
// to Lost records the move and the reason; an edit records each field. Drawn
// as separate rows they each repeat the same timestamp and the same name,
// which is what made the history read as a pile of unrelated events. Entries
// from the same person within the same minute are one moment, and are drawn
// as one row with one timestamp.
function groupTimelineItems(items){
  const MOMENT = 60000;
  const out = [];
  for(const i of items){
    const g = out[out.length - 1];
    // Day summaries (TailorTalk chat days) stand alone — they already are a
    // summary of many things and have no single author.
    const groupable = g && !i.summary && !g.summary
      && (g.by || null) === (i.by || null)
      && Math.abs(g.at - i.at) < MOMENT;
    if(groupable){ g.lines.push(i); g.at = Math.max(g.at, i.at); }
    else out.push({ at: i.at, by: i.by, summary: i.summary, lines: [i] });
  }
  return out;
}
function timelineDayLabel(ts){
  const r = relDay(ts);
  return r === 'Today' || r === 'Yesterday' ? `${r} · ${fmtDay(ts)}` : fmtDay(ts);
}
function renderTimeline(l){
  const list = document.getElementById('timelinePanel');
  const bar = document.getElementById('tlFilters');
  if(!list || !l) return;
  const items = timelineItems(l);
  const count = key => key === 'all' ? items.length : items.filter(i => i.tags.includes(key)).length;
  if(bar) bar.innerHTML = TL_FILTERS.filter(f => f.key === 'all' || f.key === tlFilter || count(f.key))
    .map(f => `<button type="button" class="tl-f${tlFilter===f.key?' at':''}" aria-pressed="${tlFilter===f.key}" onclick="setTimelineFilter('${f.key}')">${f.label}<span>${count(f.key)}</span></button>`).join('');
  const matching = tlFilter === 'all' ? items : items.filter(i => i.tags.includes(tlFilter));
  if(!matching.length){
    list.innerHTML = `<div class="empty-mini">${items.length ? 'Nothing of this kind yet.' : 'Nothing logged yet — add a note above.'}</div>`;
    return;
  }
  const groups = groupTimelineItems(matching);
  const shown = tlExpanded.has(l.id) ? groups : groups.slice(0, TL_PAGE);
  const byLabel = by => !by ? '' : by === 'AI' ? '🤖 AI' : ['TailorTalk', 'CRM rework'].includes(by) ? by : escapeHtml(String(by).split('@')[0]);
  let lastDay = null;
  list.innerHTML = shown.map(g => {
    const day = dayKeyOf(g.at);
    const head = day !== lastDay ? `<div class="tl-day">${timelineDayLabel(g.at)}</div>` : '';
    lastDay = day;
    // A note is the substance of a moment, so it sets the row's tone and its
    // icon whenever one is present.
    const lead = g.lines.find(i => i.tags.includes('notes')) || g.lines[0];
    const tags = lead.tags;
    const tone = tags.includes('notes') ? ' note' : tags.includes('ai') ? ' ai' : tags.includes('tailortalk') ? ' tt' : tags.includes('stage') ? ' stage' : '';
    const meta = [g.summary ? '' : fmtClock(g.at), byLabel(g.by)].filter(Boolean).join(' · ');
    // Notes first, then what was done — the substance before the bookkeeping.
    const ordered = [...g.lines].sort((a, b) =>
      (b.tags.includes('notes') ? 1 : 0) - (a.tags.includes('notes') ? 1 : 0));
    // The control is a sibling of the text, never inside it — otherwise the
    // note's own text reads "Sent the agreement draftDelete" to anything that
    // looks at it, tests and screen readers alike.
    const body = ordered.map(i => {
      const k = timelineKind(i);
      return `<div class="tl-line tl-k-${k.key}">
        <div class="tl-kind">${k.label}</div>
        <div class="tl-text">${i.html}</div>
        ${i.noteId ? `<button type="button" class="tl-del" onclick="deleteNote('${l.id}','${i.noteId}')">Delete</button>` : ''}
      </div>`;
    }).join('');
    return `${head}<div class="tl-item${tone}${g.lines.length > 1 ? ' tl-multi' : ''}">
      <div class="tl-ico" aria-hidden="true">${lead.icon}</div>
      <div class="tl-body">
        ${meta ? `<div class="tl-meta">${meta}</div>` : ''}
        ${body}
      </div>
    </div>`;
  }).join('') + (groups.length > shown.length ? `<button type="button" class="tt-btn tl-more" onclick="tlExpanded.add('${l.id}');renderTimeline(leads.find(x=>x.id==='${l.id}'))">Show all ${groups.length}</button>` : '');
}
function setTimelineFilter(key){
  tlFilter = TL_FILTERS.some(f => f.key === key) ? key : 'all';
  try{ localStorage.setItem(TL_FILTER_KEY, tlFilter); }catch(e){}
  const l = leads.find(x => x.id === currentDetailId);
  if(l) renderTimeline(l);
}
// Notes and history both draw into the one timeline.
function renderHistory(l){ renderTimeline(l); }

// ═══════ FOLLOW-UP SPOTLIGHT ═══════
function followUpUrgencyClass(ts){
  if(ts==null) return 'none';
  const diff = ts - Date.now();
  if(diff < 0) return 'overdue';
  if(diff < 24*60*60*1000) return 'today';
  return 'upcoming';
}
function relativeFollowUpText(ts){
  const diff = ts - Date.now();
  const abs = Math.abs(diff);
  const mins = Math.round(abs/60000);
  const hrs = Math.round(abs/3600000);
  const days = Math.round(abs/86400000);
  let phrase;
  if(mins<60) phrase = mins<=1 ? '1 minute' : mins+' minutes';
  else if(hrs<24) phrase = hrs===1 ? '1 hour' : hrs+' hours';
  else phrase = days===1 ? '1 day' : days+' days';
  return diff<0 ? `Overdue by ${phrase}` : `In ${phrase}`;
}
function renderFollowUpSpotlight(l){
  const el = document.getElementById('dpFuSpotlight');
  if(!el) return;
  if(l.followUpAt){
    const cls = followUpUrgencyClass(l.followUpAt);
    const when = new Date(l.followUpAt).toLocaleString([], { weekday:'short', month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' });
    const icoMap = { overdue:'⏰', today:'⏰', upcoming:'📅' };
    const labelMap = { overdue:'OVERDUE FOLLOW-UP', today:'FOLLOW-UP DUE TODAY', upcoming:'NEXT FOLLOW-UP' };
    el.innerHTML = `
      <div class="fu-spotlight ${cls}">
        <div class="fu-spotlight-ico">${icoMap[cls]}</div>
        <div class="fu-spotlight-main">
          <div class="fu-spotlight-label">${labelMap[cls]}</div>
          <div class="fu-spotlight-when">${when}</div>
          <div class="fu-spotlight-rel">${relativeFollowUpText(l.followUpAt)}</div>
        </div>
        <div class="fu-spotlight-actions">
          <button type="button" class="fu-spotlight-btn done" onclick="openFollowUpLogModal('${l.id}')">✓ Followed Up</button>
          <button type="button" class="fu-spotlight-btn remove" onclick="removeFollowUp('${l.id}')">✕ Remove</button>
        </div>
      </div>`;
  } else {
    el.innerHTML = `
      <div class="fu-spotlight none">
        <div class="fu-spotlight-ico">🗓️</div>
        <div class="fu-spotlight-main">
          <div class="fu-spotlight-label">No follow-up scheduled</div>
          <div class="fu-spotlight-when">Set a date to stay on top of this lead</div>
        </div>
        <div class="fu-spotlight-actions">
          <button type="button" class="fu-spotlight-btn done" onclick="openFollowUpLogModal('${l.id}')">+ Schedule</button>
        </div>
      </div>`;
  }
}

// ═══════ KANBAN BOARD ═══════

// ── Where a site visit sits in time ──
// Two different dates, and the difference matters: when the visit is BOOKED
// for, versus when the lead first asked for one. A visit asked for nine days
// ago and still unbooked is the thing that goes cold.
function visitAtOf(l){ return (l && l.ai && l.ai.visit && l.ai.visit.at) || null; }
function visitAskedAtOf(l){
  if(!l) return null;
  const sig = l.tt && l.tt.signals && l.tt.signals.site_visit;
  if(sig && sig.at) return sig.at;
  // No chat signal: the moment it entered the visit column is the best record
  // we have of when a visit was first on the table.
  if(stageKeyOfId(l.stageId) === 'visit_pending') return l.stageChangedAt || l.createdAt || null;
  return null;
}

// ── Per-column sort ──
// The board's default order answers "what should I touch first". These are the
// other questions a person actually asks of one column: who moved in here
// recently, who has just messaged, whose visit is next. Each column remembers
// its own choice, because the question differs by column — "visit time" is the
// point of the Visit planned column and meaningless in New.
const BOARD_SORTS = [
  { key:'smart',   label:'Most urgent',      meta:null },
  { key:'moved',   label:'Recently moved',   meta:l => l.stageChangedAt ? 'moved ' + timeAgo(l.stageChangedAt) : null,
    val:l => -(l.stageChangedAt || l.createdAt || 0) },
  { key:'message', label:'Recent message',   meta:l => (l.tt && l.tt.lastMessageAt) ? '💬 ' + timeAgo(l.tt.lastMessageAt) : null,
    val:l => -((l.tt && l.tt.lastMessageAt) || 0) },
  { key:'visit',   label:'Visit time',       meta:l => visitAtOf(l) ? '📍 visit ' + fmtDue(visitAtOf(l)) : null,
    val:l => visitAtOf(l) || Infinity },
  { key:'asked',   label:'Visit asked',      meta:l => visitAskedAtOf(l) ? '📍 asked ' + timeAgo(visitAskedAtOf(l)) : null,
    val:l => -(visitAskedAtOf(l) || 0) },
  { key:'followup',label:'Follow-up due',    meta:l => l.followUpAt ? '📅 ' + fmtDue(l.followUpAt) : null,
    val:l => l.followUpAt || Infinity },
  { key:'created', label:'Newest first',     meta:l => l.createdAt ? 'added ' + timeAgo(l.createdAt) : null,
    val:l => -(l.createdAt || 0) },
  { key:'name',    label:'Name A–Z',         meta:null, val:l => (l.name || '').toLowerCase() }
];
const BOARD_SORT_KEY = 'crmBoardSort';
let boardSort = {};
try{ boardSort = JSON.parse(localStorage.getItem(BOARD_SORT_KEY) || '{}') || {}; }catch(e){ boardSort = {}; }
let openSortCol = null;

function boardSortOf(stageId){
  return BOARD_SORTS.find(s => s.key === boardSort[stageId]) || BOARD_SORTS[0];
}
function setBoardSort(stageId, key){
  if(key === 'smart') delete boardSort[stageId]; else boardSort[stageId] = key;
  openSortCol = null;
  try{ localStorage.setItem(BOARD_SORT_KEY, JSON.stringify(boardSort)); }catch(e){}
  renderBoard();
}
function toggleSortMenu(stageId, ev){
  if(ev) ev.stopPropagation();
  openSortCol = openSortCol === stageId ? null : stageId;
  renderBoard();
}
// Reset every column at once — eight menus is a lot to undo one at a time.
function resetAllBoardSorts(){
  boardSort = {};
  openSortCol = null;
  try{ localStorage.removeItem(BOARD_SORT_KEY); }catch(e){}
  renderBoard();
  showToast('Every column back to Most urgent');
}
document.addEventListener('click', () => { if(openSortCol){ openSortCol = null; renderBoard(); } });

function sortColumnLeads(list, sort){
  if(sort.key === 'smart'){
    // Most urgent first, then the most recently active — what a person should look at first.
    return list.sort((a, b) => {
      const ra = topAttentionUi(a), rb = topAttentionUi(b);
      const sa = ra ? SEV_RANK[ra.severity] : -1, sb = rb ? SEV_RANK[rb.severity] : -1;
      if(sb !== sa) return sb - sa;
      const ta = Math.max(a.updatedAt||0, (a.tt && a.tt.lastMessageAt)||0), tb = Math.max(b.updatedAt||0, (b.tt && b.tt.lastMessageAt)||0);
      return tb - ta;
    });
  }
  return list.sort((a, b) => {
    const av = sort.val(a), bv = sort.val(b);
    // Leads with no value for this sort sink to the bottom rather than jumbling
    // through the middle — an empty date is not "the oldest date".
    if(typeof av === 'number' && typeof bv === 'number'){
      if(!isFinite(av) && !isFinite(bv)) return 0;
      if(!isFinite(av)) return 1;
      if(!isFinite(bv)) return -1;
      return av - bv;
    }
    return String(av).localeCompare(String(bv));
  });
}

function sortMenuHtml(stage, active){
  if(openSortCol !== stage.id) return '';
  return `<div class="kcol-sort-pop" role="menu" onclick="event.stopPropagation()">
    ${BOARD_SORTS.map(s => `<button type="button" role="menuitemradio" aria-checked="${s.key===active.key}" class="kcol-sort-opt${s.key===active.key?' at':''}" onclick="setBoardSort('${stage.id}','${s.key}')">${escapeHtml(s.label)}</button>`).join('')}
    ${Object.keys(boardSort).length ? '<div class="dd-sep"></div><button type="button" role="menuitem" class="kcol-sort-opt reset" onclick="resetAllBoardSorts()">Reset every column</button>' : ''}
  </div>`;
}

function renderBoard(){
  const board = document.getElementById('kanbanView');
  if(!stages.length){
    board.innerHTML = '<div class="nores"><div class="nores-i">🗂️</div><div class="nores-t">No pipeline stages yet</div></div>';
    return;
  }
  board.innerHTML = `<div class="kanban">${stages.map(stage=>{
    const sort = boardSortOf(stage.id);
    const colLeads = sortColumnLeads(filteredLeads.filter(l=>l.stageId===stage.id), sort);
    // The badge counts what is actually past its time, so it agrees exactly with
    // the Overdue filter chip instead of offering a second, different number.
    const overdue = colLeads.filter(isOverdueUi).length;
    const rule = stageRuleOf(stage);
    const kind = window.crmPipeline ? window.crmPipeline.stageKindOf(stage) : null;
    return `
    <div class="kcol${kind==='lost'||kind==='won'||kind==='hold' ? ' kcol-side kcol-'+kind : ''}">
      <div class="kcol-hdr">
        <div class="kcol-head">
          <div class="kcol-title"><span class="kcol-dot" style="background:${stage.color}"></span>${escapeHtml(stage.name)}</div>
          ${rule ? `<div class="kcol-rule">${escapeHtml(rule)}</div>` : ''}
        </div>
        <div class="kcol-counts">
          ${overdue ? `<span class="kcol-urgent" title="${overdue} past due in this column">${overdue}</span>` : ''}
          <div class="kcol-count">${colLeads.length}</div>
          <div class="kcol-sort${sort.key!=='smart'?' set':''}">
            <button type="button" class="kcol-sort-btn" aria-haspopup="true" aria-expanded="${openSortCol===stage.id}"
                    aria-label="Sort ${escapeHtml(stage.name)} — currently ${escapeHtml(sort.label)}"
                    title="Sorted by ${escapeHtml(sort.label)}" onclick="toggleSortMenu('${stage.id}',event)">⇅</button>
            ${sortMenuHtml(stage, sort)}
          </div>
        </div>
      </div>
      ${sort.key!=='smart' ? `<button type="button" class="kcol-sort-tag" onclick="setBoardSort('${stage.id}','smart')" title="Back to Most urgent">${escapeHtml(sort.label)} <span aria-hidden="true">×</span></button>` : ''}
      <div class="kcol-body" ondragover="onColDragOver(event)" ondragleave="onColDragLeave(event)" ondrop="onColDrop(event,'${stage.id}')">
        ${colLeads.length ? colLeads.map(l=>leadCardHtml(l, sort)).join('') : '<div class="kcol-empty">No leads</div>'}
      </div>
    </div>`;
  }).join('')}</div>`;
  restoreCardFocus();
}

// ── Keyboard equivalent of dragging a card ──
// Dragging was the only way to move a lead anywhere except one step forward, so
// a keyboard user could not work the board at all. Alt + ←/→ walks the card
// through the columns; the board is re-rendered and focus follows the card so
// you can move it again straight away.
function onCardKeydown(e, id){
  if(e.key === 'Enter' || e.key === ' '){
    if(e.target !== e.currentTarget) return;   // let buttons inside the card act
    e.preventDefault();
    openDetail(id);
    return;
  }
  if(!e.altKey || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight')) return;
  e.preventDefault();
  const l = leads.find(x => x.id === id);
  if(!l) return;
  const i = stages.findIndex(s => s.id === l.stageId);
  const to = stages[i + (e.key === 'ArrowRight' ? 1 : -1)];
  if(!to){ showToast(e.key === 'ArrowRight' ? 'Already in the last column' : 'Already in the first column'); return; }
  pendingFocusLeadId = id;
  changeStage(id, to.id);
}
// changeStage re-renders the board, which throws away the focused element — this
// puts the caret back on the card wherever it landed.
let pendingFocusLeadId = null;
function restoreCardFocus(){
  if(!pendingFocusLeadId) return;
  const el = document.querySelector(`.lcard[data-lead="${pendingFocusLeadId}"]`);
  pendingFocusLeadId = null;
  if(el){ el.focus({ preventScroll:false }); }
}

let draggedLeadId = null;
function onCardDragStart(e, id){
  draggedLeadId = id;
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', id);
  e.currentTarget.classList.add('dragging');
}
function onCardDragEnd(e){
  e.currentTarget.classList.remove('dragging');
  draggedLeadId = null;
  document.querySelectorAll('.kcol-body.drag-over').forEach(el=>el.classList.remove('drag-over'));
}
function onColDragOver(e){
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  e.currentTarget.classList.add('drag-over');
}
function onColDragLeave(e){
  e.currentTarget.classList.remove('drag-over');
}
function onColDrop(e, stageId){
  e.preventDefault();
  e.currentTarget.classList.remove('drag-over');
  const id = draggedLeadId || e.dataTransfer.getData('text/plain');
  if(id) changeStage(id, stageId);
}

// Leads created before the detailsSent field existed have it undefined, which
// reads as "No" everywhere (detail toggle, export, dashboard) — keep this the
// same strict === true test so the board never disagrees with them.
function detailsSentChip(l){
  const sent = l.detailsSent === true;
  return `<div class="lcard-flag ${sent?'sent':'not-sent'}">${sent?'📨 Details sent':'📭 Details not sent'}</div>`;
}

// The next column along the milestone path (never into Won/On hold/Lost by a one-tap button
// from somewhere unrelated). Falls back to plain column order on a pipeline without keys.
function nextLadderStageId(stageId){
  const P = window.crmPipeline;
  const key = stageKeyOfId(stageId);
  if(P && key){
    const i = P.LADDER.indexOf(key);
    if(i < 0 || i >= P.LADDER.length - 1) return null;
    return stageIdForKey(P.LADDER[i+1]);
  }
  return nextStageId(stageId);
}

// A card answers four questions at a glance, in this order: who, what are they after, what
// happens next, and is anything wrong. Everything else is one tap away on the lead page.
function leadCardHtml(l, sort){
  const next = nextLadderStageId(l.stageId);
  const nextStage = next ? stageById(next) : null;
  const src = sourceBadge(l);
  const top = topAttentionUi(l);
  const step = nextStepOf(l);
  const what = [l.propertyInterest, l.budget].filter(Boolean).map(s => escapeHtml(s)).join(' · ');
  const chips = [];
  const mention = myOpenMention(l);
  if(mention) chips.push(`<span class="tt-chip mention" title="${escapeHtml((window.crmMentions.displayName(mention.by || '') || 'Someone') + ': ' + (mention.text || ''))}">@ you</span>`);
  if(isTtLead(l)){
    const t = l.tt;
    if(TT_STATUS[t.status]) chips.push(`<span class="tt-chip ${t.status}">${TT_STATUS[t.status].icon} ${TT_STATUS[t.status].label}</span>`);
    if(t.locked) chips.push('<span class="tt-chip paused" title="The AI is paused on this chat in TailorTalk">🔒 AI paused</span>');
    if(t.lastMessageAt) chips.push(`<span class="tt-chip time" title="Last message from the lead">💬 ${timeAgo(t.lastMessageAt)}</span>`);
  }
  // The step line already says what the team owes; the alert line says the NEXT different thing.
  const attn = attentionFor(l);
  const coveredByStep = a => step && STEP_KEYS.has(a.key);
  const alertItem = attn.find(a => SEV_RANK[a.severity] >= SEV_RANK.medium && !coveredByStep(a));
  const extra = attn.filter(a => a !== alertItem && !coveredByStep(a)).length;
  const aiMoved = l.ai && l.ai.lastMove && Date.now() - l.ai.lastMove.at < 48*3600000 && l.stageId === stageIdForKey(l.ai.lastMove.to);
  // One class, one meaning. Everything else a card has to say, it says in words.
  const sevCls = isOverdueUi(l) ? ' is-overdue' : '';
  // Sorting by a value you cannot see is guesswork, so a non-default sort puts
  // the value it ordered on onto every card in that column.
  const sortMeta = sort && sort.meta ? sort.meta(l) : null;
  return `
  <div class="lcard${sevCls}" draggable="true" tabindex="0" role="link" aria-label="Open ${escapeHtml(l.name || 'lead')}" data-lead="${l.id}" ondragstart="onCardDragStart(event,'${l.id}')" ondragend="onCardDragEnd(event)" onclick="openDetail('${l.id}')" onkeydown="onCardKeydown(event,'${l.id}')">
    <div class="lcard-top">
      <div class="lcard-name">${escapeHtml(l.name)}</div>
      <div class="lcard-src ${src.cls}">${src.text}</div>
    </div>
    ${what ? `<div class="lcard-what">${what}</div>` : (l.enquiryType ? `<div class="lcard-what">${escapeHtml(l.enquiryType)}</div>` : '')}
    ${step ? `<div class="lcard-step ${step.cls}"><span class="lcard-step-t">${escapeHtml(step.text)}</span>${step.due ? `<span class="lcard-step-due">${escapeHtml(fmtDue(step.due))}</span>` : ''}</div>` : ''}
    ${alertItem ? `<div class="lcard-alert ${OVERDUE_KEYS.has(alertItem.key) ? 'overdue' : 'note'}">${escapeHtml(alertItem.label)}${extra > 0 ? ` <span class="lcard-alert-more">+${extra}</span>` : ''}</div>` : ''}
    ${sortMeta ? `<div class="lcard-sortmeta">${escapeHtml(sortMeta)}</div>` : ''}
    ${chips.length ? `<div class="lcard-tt">${chips.slice(0,2).join('')}</div>` : ''}
    <div class="lcard-foot">
      <div class="lcard-time">${stageAgeHtml(l)}${aiMoved ? `<span class="lcard-ai" title="${escapeHtml(l.ai.lastMove.evidence || '')}">🤖 moved ${timeAgo(l.ai.lastMove.at)}</span>` : `${timeAgo(l.updatedAt||l.createdAt)}${l.updatedBy?' · '+escapeHtml(l.updatedBy.split('@')[0]):''}`}</div>
      ${nextStage?`<button class="lcard-next" onclick="event.stopPropagation();changeStage('${l.id}','${next}')">→ ${escapeHtml(nextStage.name)}</button>`:''}
    </div>
  </div>`;
}

// ═══════ LIST VIEW (sortable + per-column filter, Excel-style) ═══════
function sourceLabel(s){ return s==='meta'?'📱 Meta':(s==='whatsapp_bot'?'🤖 WhatsApp Bot':(s==='tailortalk'?'💬 TailorTalk':'✍️ Manual')); }
const LIST_COLUMNS = [
  { key:'name', label:'Name', filterable:true, get:l=>l.name||'', sortVal:l=>(l.name||'').toLowerCase() },
  { key:'contact', label:'Contact', filterable:false, get:l=>l.phone||l.email||'—', sortVal:l=>(l.phone||l.email||'').toLowerCase() },
  { key:'channel', label:'Channel', filterable:true, get:l=>l.channel?channelLabel(l.channel):'—', sortVal:l=>l.channel?channelLabel(l.channel):'' },
  { key:'enquiryType', label:'Type', filterable:true, get:l=>l.enquiryType||'—', sortVal:l=>(l.enquiryType||'').toLowerCase() },
  { key:'propertyInterest', label:'Interest', filterable:true, get:l=>l.propertyInterest||'—', sortVal:l=>(l.propertyInterest||'').toLowerCase() },
  { key:'stage', label:'Stage', filterable:true, get:l=>{ const s=stageById(l.stageId); return s?s.name:'—'; }, sortVal:l=>{ const s=stageById(l.stageId); return s?s.name.toLowerCase():''; } },
  { key:'next', label:'Next step', filterable:false, get:l=>{ const s=nextStepOf(l); return s?s.text:'—'; }, sortVal:l=>{ const t=topAttentionUi(l); return t ? -SEV_RANK[t.severity]*1e13 + (t.at||0) : 9e15; } },
  { key:'source', label:'Source', filterable:true, get:l=>sourceLabel(l.source), sortVal:l=>sourceLabel(l.source).toLowerCase() },
  { key:'ttStatus', label:'TailorTalk', filterable:true, get:l=>isTtLead(l)?(ttStatusLabel(l.tt.status)||'Linked'):'—', sortVal:l=>{ const order={hot:0,warm:1,cold:2,converted:3,dead:4}; return isTtLead(l)?(order[l.tt.status]??5):9; } },
  { key:'ttLastMessage', label:'Last message', filterable:false, get:l=>isTtLead(l)&&l.tt.lastMessageAt?timeAgo(l.tt.lastMessageAt):'—', sortVal:l=>isTtLead(l)?(l.tt.lastMessageAt||0):0 },
  { key:'followUpAt', label:'Follow-up', filterable:false, get:l=>l.followUpAt?new Date(l.followUpAt).toLocaleDateString():'—', sortVal:l=>l.followUpAt||0 },
  { key:'updatedAt', label:'Updated', filterable:false, get:l=>timeAgo(l.updatedAt||l.createdAt), sortVal:l=>l.updatedAt||l.createdAt||0 },
  { key:'updatedBy', label:'Updated By', filterable:true, get:l=>l.updatedBy||'—', sortVal:l=>(l.updatedBy||'').toLowerCase() }
];
let listSortCol = null;
let listSortDir = 'asc';
let listColumnFilters = {}; // key -> Set of allowed display values; absent = no filter
let openFilterCol = null;

// ═══════ BULK ACTIONS (list view) ═══════
// Tick rows, then move them, set or clear their follow-up in one go. Every lead still goes
// through the same path as a single change (changeStage / history / persistLead), so the log,
// milestone dates and the AI's "a person decided" rule are identical to doing it one by one.
let bulkSelected = new Set();
let listVisibleIds = [];
let bulkFuOpen = false;
function toggleBulkLead(id, on){ if(on) bulkSelected.add(id); else bulkSelected.delete(id); renderList(); }
function toggleBulkAll(on){ bulkSelected = on ? new Set(listVisibleIds) : new Set(); renderList(); }
function clearBulkSelection(){ bulkSelected = new Set(); bulkFuOpen = false; renderList(); }
function bulkBarHtml(){
  const n = bulkSelected.size;
  if(!n) return '';
  const opts = stages.map(s => `<option value="${escapeHtml(s.id)}">${escapeHtml(s.name)}</option>`).join('');
  const fu = bulkFuOpen ? `<span class="bulk-fu">
      <input type="date" id="bulkFuDate" value="${toDateInputValue(new Date(Date.now() + 86400000))}">
      <input type="time" id="bulkFuTime" value="10:00">
      <button class="primary" onclick="bulkSetFollowUp()">Set</button>
    </span>` : '';
  return `<div class="bulk-bar" role="toolbar" aria-label="Bulk actions">
    <b>${n} selected</b>
    <select aria-label="Move selected to" onchange="bulkMoveTo(this.value); this.value=''"><option value="">Move to…</option>${opts}</select>
    <button onclick="bulkFuOpen=!bulkFuOpen; renderList()">Set follow-up</button>${fu}
    <button onclick="bulkClearFollowUp()">Clear follow-up</button>
    <button class="quiet" onclick="clearBulkSelection()">Cancel</button>
  </div>`;
}
function bulkLeads(){ return [...bulkSelected].map(id => leads.find(l => l.id === id)).filter(Boolean); }
function bulkMoveTo(stageId){
  if(!stageId) return;
  const kind = stageKindOfId(stageId);
  const ids = bulkLeads().filter(l => l.stageId !== stageId).map(l => l.id);
  if(!ids.length){ showToast('Already in that column'); return; }
  if(kind === 'lost' || kind === 'hold'){ openStageReasonModal(null, stageId, { leadIds: ids }); return; }
  bulkApplyStage(ids, stageId, {});
}
function bulkApplyStage(ids, stageId, opts){
  ids.forEach(id => changeStage(id, stageId, { ...opts, silent: true }));
  const st = stageById(stageId);
  clearBulkSelection();
  applyFilters();
  showToast(`✓ Moved ${ids.length} lead${ids.length === 1 ? '' : 's'} to ${st ? st.name : 'the column'}`);
}
function bulkSetFollowUp(){
  const d = document.getElementById('bulkFuDate'), t = document.getElementById('bulkFuTime');
  const r = computeFollowUpAt(d ? d.value : '', t ? t.value : '');
  if(!d || !d.value){ showToast('Pick a date'); return; }
  if(r.error){ showToast(r.error); return; }
  const now = Date.now();
  const when = new Date(r.value).toLocaleString([], { month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' });
  const list = bulkLeads();
  list.forEach(l => {
    if(l.followUpAt === r.value) return;
    addHistory(l, 'followup', `Next follow-up ${l.followUpAt ? 'changed to' : 'set for'} <b>${when}</b> (bulk)`);
    l.followUpAt = r.value; l.followUpBy = currentUserEmail || 'team'; l.followUpSetAt = now; l.followUpNote = null;
    l.updatedAt = now; l.updatedBy = currentUserEmail || l.updatedBy || null; l.lastActionType = 'followup';
    persistLead(l);
  });
  clearBulkSelection();
  refreshAll();
  showToast(`✓ Follow-up set for ${list.length} lead${list.length === 1 ? '' : 's'}`);
}
function bulkClearFollowUp(){
  const list = bulkLeads().filter(l => l.followUpAt);
  if(!list.length){ showToast('None of them has a follow-up'); return; }
  if(!confirm(`Remove the follow-up from ${list.length} lead${list.length === 1 ? '' : 's'}?`)) return;
  const now = Date.now();
  list.forEach(l => {
    addHistory(l, 'followup-removed', 'Follow-up removed (bulk)');
    l.followUpAt = null; l.followUpBy = currentUserEmail || 'team'; l.followUpSetAt = now; l.followUpNote = null;
    l.updatedAt = now; l.updatedBy = currentUserEmail || l.updatedBy || null; l.lastActionType = 'followup-removed';
    persistLead(l);
  });
  clearBulkSelection();
  refreshAll();
  showToast(`Follow-up removed from ${list.length} lead${list.length === 1 ? '' : 's'}`);
}

// Filter dropdowns list values from filteredLeads (the global search/source
// filter), not from other columns' filters — a lightweight approximation of
// Excel's cascading filters, good enough for this dataset's size.
function listFilterOptions(col){
  const counts = new Map();
  filteredLeads.forEach(l=>{
    const v = col.get(l);
    counts.set(v, (counts.get(v)||0)+1);
  });
  return Array.from(counts.entries()).sort((a,b)=>a[0].localeCompare(b[0]));
}
function passesColumnFilters(l){
  return LIST_COLUMNS.every(col=>{
    if(!col.filterable) return true;
    const set = listColumnFilters[col.key];
    if(!set) return true;
    return set.has(col.get(l));
  });
}
function toggleListSort(key){
  if(listSortCol===key){ listSortDir = listSortDir==='asc' ? 'desc' : 'asc'; }
  else { listSortCol = key; listSortDir = 'asc'; }
  renderList();
}
function toggleListFilter(key, ev){
  if(ev) ev.stopPropagation();
  openFilterCol = openFilterCol===key ? null : key;
  renderList();
}
function toggleListFilterValue(key, value){
  let set = listColumnFilters[key];
  if(!set){
    const col = LIST_COLUMNS.find(c=>c.key===key);
    set = new Set(listFilterOptions(col).map(([v])=>v));
    listColumnFilters[key] = set;
  }
  if(set.has(value)) set.delete(value); else set.add(value);
  renderList();
}
function selectAllListFilter(key){ delete listColumnFilters[key]; renderList(); }
function clearListFilterToNone(key){ listColumnFilters[key] = new Set(); renderList(); }
document.addEventListener('click', ()=>{
  if(openFilterCol){ openFilterCol = null; renderList(); }
});

function renderFilterDropdown(col){
  const options = listFilterOptions(col);
  const optsHtml = options.length ? options.map(([value,count])=>{
    const checked = isFilterValueChecked(col.key, value) ? 'checked' : '';
    return `<label class="lv-filter-opt">
      <input type="checkbox" ${checked} data-val="${escapeHtml(value)}" onclick="toggleListFilterValue('${col.key}', this.dataset.val)">
      <span>${escapeHtml(value)||'(blank)'}</span>
      <span class="lv-filter-count">${count}</span>
    </label>`;
  }).join('') : '<div class="lv-filter-empty">No values</div>';
  return `<div class="lv-filter-pop" onclick="event.stopPropagation()">
    <div class="lv-filter-actions">
      <button onclick="selectAllListFilter('${col.key}')">Select all</button>
      <button onclick="clearListFilterToNone('${col.key}')">Clear</button>
    </div>
    <div class="lv-filter-opts">${optsHtml}</div>
  </div>`;
}
function isFilterValueChecked(key, value){
  const set = listColumnFilters[key];
  return !set || set.has(value);
}

function renderList(){
  const wrap = document.getElementById('listView');
  if(!filteredLeads.length){
    wrap.innerHTML = '<div class="nores"><div class="nores-i">🗂️</div><div class="nores-t">No leads match your filters</div></div>';
    return;
  }

  let rows = filteredLeads.filter(passesColumnFilters);
  if(listSortCol){
    const col = LIST_COLUMNS.find(c=>c.key===listSortCol);
    rows = rows.slice().sort((a,b)=>{
      const av = col.sortVal(a), bv = col.sortVal(b);
      const cmp = (typeof av==='number' && typeof bv==='number') ? av-bv : String(av).localeCompare(String(bv));
      return listSortDir==='asc' ? cmp : -cmp;
    });
  }

  const theadHtml = `<tr>${LIST_COLUMNS.map(col=>{
    const sorted = listSortCol===col.key;
    const sortIcon = sorted ? (listSortDir==='asc'?'▲':'▼') : '↕';
    const filterActive = listColumnFilters[col.key] ? ' active' : '';
    const filterBtn = col.filterable ? `<button class="lv-filter-btn${filterActive}" aria-label="Filter by ${escapeHtml(col.label)}" aria-expanded="${openFilterCol===col.key}" onclick="toggleListFilter('${col.key}',event)">▾</button>` : '';
    const dropdown = (col.filterable && openFilterCol===col.key) ? renderFilterDropdown(col) : '';
    // aria-sort tells a screen reader what the ▲/▼ glyph tells everyone else.
    const ariaSort = sorted ? (listSortDir==='asc'?'ascending':'descending') : 'none';
    return `<th class="${col.key==='name'?'lv-name':''}" aria-sort="${ariaSort}">
      <div class="lv-th">
        <button type="button" class="lv-th-label" aria-label="Sort by ${escapeHtml(col.label)}" onclick="toggleListSort('${col.key}')">${col.label} <span class="lv-sort-ico" aria-hidden="true">${sortIcon}</span></button>
        ${filterBtn}
      </div>
      ${dropdown}
    </th>`;
  }).join('')}</tr>`;

  // Selection only ever covers rows on screen — a filter change drops leads that left the list,
  // so a bulk action can never touch a lead nobody can see.
  const visibleIds = new Set(rows.map(l => l.id));
  bulkSelected = new Set([...bulkSelected].filter(id => visibleIds.has(id)));
  listVisibleIds = rows.map(l => l.id);
  const allSel = rows.length > 0 && rows.every(l => bulkSelected.has(l.id));
  const selHead = `<th class="lv-sel"><input type="checkbox" aria-label="Select all" ${allSel ? 'checked' : ''} onclick="event.stopPropagation();toggleBulkAll(this.checked)"></th>`;

  if(!rows.length){
    wrap.innerHTML = `<div class="lv-scroll"><div class="list-view"><table><thead>${theadHtml.replace('<tr>', '<tr>' + selHead)}</thead></table></div></div>
      <div class="nores"><div class="nores-i">🔍</div><div class="nores-t">No leads match the current column filters</div></div>`;
    wireListScroll();
    return;
  }

  wrap.innerHTML = `${bulkBarHtml()}<div class="lv-scroll"><div class="list-view"><table>
    <thead>${theadHtml.replace('<tr>', '<tr>' + selHead)}</thead>
    <tbody>${rows.map(l=>{
      const stage = stageById(l.stageId);
      const sel = bulkSelected.has(l.id);
      // tabindex + Enter/Space make the row reachable without a mouse; the row is
      // the primary way into a lead, so it cannot be click-only.
      return `<tr class="${sel ? 'sel' : ''}" tabindex="0" role="link" aria-label="Open ${escapeHtml(l.name)}" onclick="openDetail('${l.id}')" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();openDetail('${l.id}');}">
        <td class="lv-sel" onclick="event.stopPropagation()"><input type="checkbox" aria-label="Select ${escapeHtml(l.name)}" ${sel ? 'checked' : ''} onclick="toggleBulkLead('${l.id}', this.checked)"></td>
        <td class="lv-name"><b>${escapeHtml(l.name)}</b></td>
        <td>${escapeHtml(l.phone||l.email||'—')}</td>
        <td>${l.channel?channelLabel(l.channel):'—'}</td>
        <td>${escapeHtml(l.enquiryType||'—')}</td>
        <td>${escapeHtml(l.propertyInterest||'—')}</td>
        <td>${stage?`<span class="stage-pill" style="background:${stage.color}22;color:${stage.color}">${escapeHtml(stage.name)}</span>`:'—'}</td>
        <td>${(() => { const s = nextStepOf(l); const t = topAttentionUi(l); return s || t ? `<span class="lv-next ${t ? t.severity : ''}">${escapeHtml(s ? s.text : t.label)}${s && s.due ? ` · ${escapeHtml(fmtDue(s.due))}` : ''}</span>` : '—'; })()}</td>
        <td>${sourceLabel(l.source)}</td>
        <td>${isTtLead(l)?`<span class="tt-chip ${escapeHtml(l.tt.status||'')}">${TT_STATUS[l.tt.status]?TT_STATUS[l.tt.status].icon+' ':''}${escapeHtml(ttStatusLabel(l.tt.status)||'Linked')}</span>${ttNeedsAttention(l)?' <span class="tt-chip alert" title="Escalated or flagged in TailorTalk">🚨</span>':''}`:'—'}</td>
        <td>${isTtLead(l)&&l.tt.lastMessageAt?timeAgo(l.tt.lastMessageAt):'—'}</td>
        <td>${l.followUpAt?new Date(l.followUpAt).toLocaleDateString():'—'}</td>
        <td>${timeAgo(l.updatedAt||l.createdAt)}</td>
        <td>${l.updatedBy?escapeHtml(l.updatedBy):'—'}</td>
      </tr>`;
    }).join('')}</tbody>
  </table></div></div>
    <div class="lv-scroll-hint" role="status"><span aria-hidden="true">↔</span> <span id="lvScrollHint"></span></div>`;
  wireListScroll();
  updateViewsChip();
}

// ═══════ LIST VIEW SCROLL AFFORDANCE ═══════
// The table is wider than any screen. Without a visible edge on the side that
// still has content, the box looks finished and nobody thinks to scroll it —
// which is exactly how 14 columns end up feeling like 6.
function wireListScroll(){
  const box = document.querySelector('#listView .lv-scroll');
  const sc = box && box.querySelector('.list-view');
  if(!box || !sc) return;

  const sync = () => {
    const selTh = sc.querySelector('th.lv-sel');
    if(selTh) box.style.setProperty('--lv-sel-w', selTh.getBoundingClientRect().width + 'px');
    const hidden = sc.scrollWidth - sc.clientWidth;
    box.classList.toggle('can-scroll-x', hidden > 4);
    box.classList.toggle('has-more-x', hidden - sc.scrollLeft > 4);
    box.classList.toggle('is-scrolled-x', sc.scrollLeft > 2);
    const hint = document.getElementById('lvScrollHint');
    if(hint) hint.textContent = hidden > 4
      ? `${Math.round(hidden)}px more to the right — shift + scroll, or drag the bar`
      : '';
  };

  sc.addEventListener('scroll', () => { sync(); positionListFilterPop(); }, { passive:true });
  // A vertical wheel over a table that only scrolls sideways does nothing on a
  // mouse without a tilt wheel — the commonest way this reads as "broken".
  // Translate it, but only while there is somewhere left to go, so the page
  // still scrolls normally once the table hits its edge.
  sc.addEventListener('wheel', e => {
    if(e.deltaX || e.shiftKey) return;
    const hidden = sc.scrollWidth - sc.clientWidth;
    if(hidden <= 4) return;
    const room = e.deltaY > 0 ? hidden - sc.scrollLeft : sc.scrollLeft;
    // Only claim the gesture when the table itself cannot scroll vertically;
    // otherwise a tall table would refuse to scroll down at all.
    if(sc.scrollHeight - sc.clientHeight > 4) return;
    if(room <= 0) return;
    e.preventDefault();
    sc.scrollLeft += e.deltaY;
  }, { passive:false });

  if(window.ResizeObserver){
    const ro = new ResizeObserver(sync);
    ro.observe(sc);
    const t = sc.querySelector('table');
    if(t) ro.observe(t);
  }
  sync();
  positionListFilterPop();
}

// The filter dropdown lives inside a `th`, and the table is now a scroll
// container — an absolutely positioned pop would be clipped by it the moment
// it hung past the edge. Lifting it to `position:fixed` and placing it against
// the trigger's own rect lets it sit over the table, and clamps it into the
// viewport so a right-hand column's menu is never half off-screen.
function positionListFilterPop(){
  const pop = document.querySelector('#listView .lv-filter-pop');
  if(!pop) return;
  const th = pop.closest('th');
  const btn = th && th.querySelector('.lv-filter-btn');
  const sc = document.querySelector('#listView .list-view');
  if(!btn || !sc) return;

  const b = btn.getBoundingClientRect();
  const box = sc.getBoundingClientRect();
  // Scrolled out of the table's own viewport: nothing to anchor to.
  if(b.right < box.left - 1 || b.left > box.right + 1){ pop.style.visibility = 'hidden'; return; }
  pop.style.visibility = '';

  const w = pop.offsetWidth || 200, h = pop.offsetHeight || 260;
  const pad = 8;
  let left = Math.min(b.left, window.innerWidth - w - pad);
  let top = b.bottom + 4;
  // Flip above the trigger rather than run off the bottom of the window.
  if(top + h > window.innerHeight - pad) top = Math.max(pad, b.top - h - 4);
  pop.style.left = Math.max(pad, left) + 'px';
  pop.style.top = top + 'px';
}
addEventListener('resize', positionListFilterPop);
// Capture phase so it also fires for the page scroll that moves the whole table.
addEventListener('scroll', positionListFilterPop, true);

// ═══════ FOLLOW-UPS VIEW (date-grouped, calendar-style) ═══════
const FU_GROUP_DEFS = [
  { key:'overdue', label:'⚠️ Overdue' },
  { key:'today', label:'📅 Today' },
  { key:'tomorrow', label:'🌤️ Tomorrow' },
  { key:'week', label:'🗓️ This Week' },
  { key:'later', label:'📆 Later' }
];
// Which stages to show (empty = every stage — same "toggle into a Set" convention as the List
// view's column filters) and which end of each day-bucket to read first. The buckets themselves
// stay: they are already a coarse sort by urgency, and collapsing overdue/today/tomorrow into one
// flat list would bury "how overdue" under "how soon" for anything not yet due.
let fuStageFilter = new Set();
let fuSortDesc = false;
function passesFuStageFilter(l){ return !fuStageFilter.size || fuStageFilter.has(l.stageId); }
function toggleFuStage(stageId){
  if(fuStageFilter.has(stageId)) fuStageFilter.delete(stageId); else fuStageFilter.add(stageId);
  renderFollowups();
}
function setFuSort(desc){
  if(fuSortDesc === desc) return;
  fuSortDesc = desc;
  renderFollowups();
}
function followupBuckets(list){
  const now = Date.now();
  const startOfToday = new Date(new Date().setHours(0,0,0,0)).getTime();
  const startOfTomorrow = startOfToday + 86400000;
  const startOfDayAfter = startOfTomorrow + 86400000;
  const startOfNextWeek = startOfToday + 7*86400000;
  const buckets = { overdue:[], today:[], tomorrow:[], week:[], later:[] };
  list.forEach(l=>{
    const t = l.followUpAt;
    if(t < now) buckets.overdue.push(l);
    else if(t < startOfTomorrow) buckets.today.push(l);
    else if(t < startOfDayAfter) buckets.tomorrow.push(l);
    else if(t < startOfNextWeek) buckets.week.push(l);
    else buckets.later.push(l);
  });
  Object.values(buckets).forEach(arr=>arr.sort((a,b)=> fuSortDesc ? b.followUpAt-a.followUpAt : a.followUpAt-b.followUpAt));
  return buckets;
}
function fuControlsHtml(list){
  const inUse = stages.filter(s => list.some(l => l.stageId === s.id));
  if(!inUse.length) return '';
  const stageChips = inUse.map(s=>{
    const on = !fuStageFilter.size || fuStageFilter.has(s.id);
    const n = list.filter(l=>l.stageId===s.id).length;
    return `<button type="button" class="fu-fchip${on?' on':''}" style="--sc:${s.color}" onclick="toggleFuStage('${s.id}')">${escapeHtml(s.name)}<span class="fu-n">${n}</span></button>`;
  }).join('');
  return `<div class="fu-controls">
    <div class="fu-fchips">${stageChips}</div>
    <div class="fu-sortbar" role="group" aria-label="Sort follow-ups">
      <button type="button" class="fu-sbtn${fuSortDesc?'':' on'}" aria-pressed="${!fuSortDesc}" onclick="setFuSort(false)">Most overdue first</button>
      <button type="button" class="fu-sbtn${fuSortDesc?' on':''}" aria-pressed="${fuSortDesc}" onclick="setFuSort(true)">Least overdue first</button>
    </div>
  </div>`;
}
// The badge counts leads that need a person NOW (critical or high) — one number that means
// "open the queue", instead of every follow-up due at some point today.
function updateFollowupBadge(){
  const urgent = leads.filter(l => !isBusinessLead(l) && isUrgentUi(l));
  // The count sits on Follow-ups in the rail, so it is visible from every
  // console rather than only from this page's header.
  if(window.AppNav) window.AppNav.setBadge('followups', urgent.length);
}

// Reasons whose time is a due time (show it); the rest carry when something last happened.
const DUE_KEYS = new Set(['promise_overdue', 'team_owes', 'followup_overdue', 'visit_outcome', 'hold_due', 'window_closing']);
const QUEUE_GROUPS = [
  { key:'critical', label:'🔴 Do now', hint:'Promised and overdue, or the reply window is closing' },
  { key:'high',     label:'🟠 Today',  hint:'Waiting on the team' },
  { key:'medium',   label:'🟡 This week', hint:'Keep the deal moving' }
];
function queueRowHtml(l, a){
  const stage = stageById(l.stageId);
  const waUrl = waHref(l.phone);
  return `<div class="fu-row q-row ${a.severity}" onclick="openDetail('${l.id}')">
    <div class="fu-row-main">
      <div class="fu-name-row">
        <span class="fu-name">${escapeHtml(l.name)}</span>
        ${stage?`<span class="stage-pill sm" style="background:${stage.color}22;color:${stage.color}">${escapeHtml(stage.name)}</span>`:''}
      </div>
      <div class="q-what">${escapeHtml(a.label)}</div>
      ${a.detail ? `<div class="fu-note">${escapeHtml(a.detail)}</div>` : ''}
    </div>
    <div class="fu-row-side">
      ${a.at && DUE_KEYS.has(a.key) ? `<div class="fu-time ${a.severity==='critical'?'overdue':'today'}">${escapeHtml(fmtDue(a.at))}</div>` : ''}
      <button class="fu-action-btn done" onclick="event.stopPropagation();openFollowUpLogModal('${l.id}')" title="Log what you did">✓</button>
      ${waUrl?`<a class="fu-wa-btn" href="${waUrl}" target="_blank" rel="noopener" onclick="event.stopPropagation()">💬</a>`:''}
    </div>
  </div>`;
}
function actionQueueHtml(list){
  const items = list.filter(l => !isBusinessLead(l)).map(l => ({ l, a: topAttentionUi(l) })).filter(x => x.a && SEV_RANK[x.a.severity] >= SEV_RANK.medium);
  if(!items.length) return '<div class="q-empty">✓ Nothing needs a person right now.</div>';
  return QUEUE_GROUPS.map(g => {
    const rows = items.filter(x => x.a.severity === g.key).sort((x, y) => (x.a.at || Infinity) - (y.a.at || Infinity));
    if(!rows.length) return '';
    return `<div class="fu-group">
      <div class="fu-group-hdr q-${g.key}">${g.label} <span class="fu-count">${rows.length}</span><span class="q-hint">${g.hint}</span></div>
      <div class="fu-rows">${rows.map(x => queueRowHtml(x.l, x.a)).join('')}</div>
    </div>`;
  }).join('');
}
function followupRowHtml(l, bucketKey){
  const stage = stageById(l.stageId);
  // Prefer the denormalized lastNote (on the parent) — the follow-ups view
  // renders leads whose full notes[] subcollection hasn't been loaded.
  const latest = l.lastNote || (l.notes||[]).slice().sort((a,b)=>b.createdAt-a.createdAt)[0] || null;
  const waUrl = waHref(l.phone);
  const fuDate = new Date(l.followUpAt);
  const timeLabel = (bucketKey==='today' || bucketKey==='overdue')
    ? fuDate.toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'})
    : fuDate.toLocaleString([], {month:'short', day:'numeric', hour:'2-digit', minute:'2-digit'});
  // "Overdue" on its own only ever said WHEN it was due, never how overdue it now is — the exact
  // complaint. relativeFollowUpText already exists for the lead-detail spotlight (line ~1667);
  // reused here rather than a second implementation of the same day/hour math.
  const rel = relativeFollowUpText(l.followUpAt);
  return `<div class="fu-row" onclick="openDetail('${l.id}')">
    <div class="fu-row-main">
      <div class="fu-name-row">
        <span class="fu-name">${escapeHtml(l.name)}</span>
        ${stage?`<span class="stage-pill sm" style="background:${stage.color}22;color:${stage.color}">${escapeHtml(stage.name)}</span>`:''}
        ${isSellerLead(l)?`<span class="stage-pill sm fu-seller-pill">Seller</span>`:''}
      </div>
      <div class="fu-meta">
        ${l.phone?`<span>📞 ${escapeHtml(l.phone)}</span>`:''}
        ${l.propertyInterest?`<span>🏠 ${escapeHtml(l.propertyInterest)}</span>`:''}
        ${l.budget?`<span>💰 ${escapeHtml(l.budget)}</span>`:''}
      </div>
      <div class="fu-note ${latest?'':'empty'}">${latest ? `“${escapeHtml(latest.text)}” <span class="fu-note-time">— ${timeAgo(latest.createdAt)}</span>` : 'No notes yet'}</div>
    </div>
    <div class="fu-row-side">
      <div class="fu-time-wrap">
        <div class="fu-time ${bucketKey}">${escapeHtml(rel)}</div>
        <div class="fu-time-exact">${timeLabel}</div>
      </div>
      <button class="fu-action-btn done" onclick="event.stopPropagation();openFollowUpLogModal('${l.id}')" title="Log follow-up">✓</button>
      <button class="fu-action-btn remove" onclick="event.stopPropagation();removeFollowUp('${l.id}')" title="Remove follow-up">✕</button>
      ${waUrl?`<a class="fu-wa-btn" href="${waUrl}" target="_blank" rel="noopener" onclick="event.stopPropagation()">💬</a>`:''}
    </div>
  </div>`;
}
function renderFollowups(){
  const wrap = document.getElementById('followupsView');
  const queue = `<div class="q-wrap"><div class="q-title">Needs a person</div>${actionQueueHtml(filteredLeads)}</div>`;
  const openStages = l => { const k = stageKindOfId(l.stageId); return k !== 'won' && k !== 'lost'; };
  const withFollowup = filteredLeads.filter(l=>l.followUpAt && openStages(l));
  if(!withFollowup.length){
    wrap.innerHTML = `<div class="fu-wrap">${queue}<div class="nores"><div class="nores-i">📅</div><div class="nores-t">No follow-ups scheduled</div><div class="nores-sub">Set one from a lead\'s Notes &amp; Follow-ups section.</div></div></div>`;
    return;
  }
  // The stage filter is scoped to this view's own list, on top of whatever the page's own
  // scope/focus/search bar already narrowed filteredLeads to.
  const shown = withFollowup.filter(passesFuStageFilter);
  const controls = fuControlsHtml(withFollowup);
  if(!shown.length){
    wrap.innerHTML = `<div class="fu-wrap">${queue}<div class="q-title">Follow-up calendar</div>${controls}<div class="nores"><div class="nores-i">📅</div><div class="nores-t">No follow-ups in the selected stages</div></div></div>`;
    return;
  }
  const buckets = followupBuckets(shown);
  const groupsHtml = FU_GROUP_DEFS.map(g=>{
    const arr = buckets[g.key];
    if(!arr.length) return '';
    return `<div class="fu-group">
      <div class="fu-group-hdr ${g.key}">${g.label} <span class="fu-count">${arr.length}</span></div>
      <div class="fu-rows">${arr.map(l=>followupRowHtml(l, g.key)).join('')}</div>
    </div>`;
  }).join('');
  wrap.innerHTML = `<div class="fu-wrap">${queue}<div class="q-title">Follow-up calendar</div>${controls}${groupsHtml}</div>`;
}

// A person moving a lead. Lost and On hold ask why (and until when) first — that reason is
// what the dashboard, the AI and whoever picks the lead up next rely on.
function changeStage(id, stageId, opts = {}){
  const l = leads.find(x=>x.id===id);
  if(!l) return;
  const toKind = stageKindOfId(stageId);
  if(l.stageId !== stageId && (toKind === 'lost' || toKind === 'hold') && !opts.reason){
    openStageReasonModal(id, stageId, opts);
    applyFilters();
    if(currentDetailId===id) renderDetailStageRow(l);
    return;
  }
  const stageChanged = l.stageId !== stageId;
  const now = Date.now();
  if(stageChanged){
    const oldStage = stageById(l.stageId);
    const newStage = stageById(stageId);
    const P = window.crmPipeline;
    let why = '';
    if(toKind === 'lost' && opts.reason) why = ` (${escapeHtml((P && P.LOST_REASONS[opts.reason]) || opts.reason)})`;
    if(toKind === 'hold' && opts.reason) why = ` (${escapeHtml((P && P.HOLD_REASONS[opts.reason]) || opts.reason)}${opts.until ? ', revisit '+escapeHtml(fmtDue(opts.until)) : ''})`;
    if(oldStage && newStage){
      addHistory(l, 'stage', `Stage changed from <b>${escapeHtml(oldStage.name)}</b> to <b>${escapeHtml(newStage.name)}</b>${why}`);
    }
    // Denormalized onto the parent doc (same write, no extra read/write) so
    // the Dashboard's computeDashboardMetrics can tell "moved to stage X
    // today" apart from a note/follow-up update without reading history.
    l.prevStageId = l.stageId;
    l.stageChangedAt = now;
    // Who decided: the AI does not override a person's choice until the lead says something new.
    l.stageChangedBy = currentUserEmail || 'team';
    markReached(l, stageId, now);
    const fromKind = stageKindOfId(l.stageId);
    if(fromKind === 'lost' && toKind !== 'lost') l.lostReason = null;
    if(fromKind === 'hold' && toKind !== 'hold'){ l.holdReason = null; l.holdUntil = null; }
    if(toKind === 'lost'){ l.lostReason = opts.reason || l.lostReason || 'other'; }
    if(toKind === 'hold'){
      l.holdReason = opts.reason || 'other';
      l.holdUntil = opts.until || null;
      if(opts.until){ l.followUpAt = opts.until; l.followUpBy = currentUserEmail || 'team'; l.followUpSetAt = now; l.followUpNote = 'Revisit — the lead asked to be contacted around now'; }
    }
    if(toKind === 'lost' || toKind === 'won'){ l.followUpAt = null; }
  }
  l.stageId = stageId;
  l.updatedAt = now;
  l.updatedBy = currentUserEmail || l.updatedBy || null;
  if(stageChanged) l.lastActionType = 'stage';
  persistLead(l);
  // Bulk actions change many leads and redraw once at the end.
  if(opts.silent) return;
  applyFilters();
  if(currentDetailId===id){ renderDetailStageRow(l); renderHistory(l); renderStandSection(l); renderFollowUpSpotlight(l); renderNoteFollowUpFields(l); }
}

// ── Reason for Lost / On hold ──
let stageReasonDraft = null;
function openStageReasonModal(leadId, stageId, opts = {}){
  const P = window.crmPipeline;
  const kind = stageKindOfId(stageId);
  // Bulk: one reason for every selected lead.
  const bulk = Array.isArray(opts.leadIds) && opts.leadIds.length ? opts.leadIds : null;
  const l = bulk ? { name: `${bulk.length} lead${bulk.length === 1 ? '' : 's'}`, ai: null } : leads.find(x=>x.id===leadId);
  if(!P || !l) return;
  stageReasonDraft = { leadId, leadIds: bulk, stageId, kind };
  const reasons = kind === 'lost' ? P.LOST_REASONS : P.HOLD_REASONS;
  const pre = opts.reasonHint || (kind === 'lost' ? (l.ai && l.ai.lostReason) : (l.ai && l.ai.holdReason)) || '';
  const verb = bulk && bulk.length > 1 ? 'are' : 'is';
  document.getElementById('srTitle').textContent = kind === 'lost' ? `Why ${verb} ${l.name} lost?` : `Why ${verb} ${l.name} on hold?`;
  document.getElementById('srReason').innerHTML = Object.entries(reasons).map(([k, v]) => `<option value="${k}" ${k===pre?'selected':''}>${escapeHtml(v)}</option>`).join('');
  document.getElementById('srUntilRow').style.display = kind === 'hold' ? '' : 'none';
  const hint = opts.untilHint || (l.ai && l.ai.holdUntil) || null;
  document.getElementById('srUntil').value = hint ? toDateInputValue(new Date(hint)) : '';
  document.getElementById('srErr').classList.remove('show');
  document.getElementById('stageReasonModal').classList.add('open');
}
function closeStageReasonModal(){
  document.getElementById('stageReasonModal').classList.remove('open');
  stageReasonDraft = null;
}
function saveStageReason(){
  const d = stageReasonDraft;
  if(!d) return;
  const reason = document.getElementById('srReason').value;
  let until = null;
  if(d.kind === 'hold'){
    const v = document.getElementById('srUntil').value;
    if(v){
      until = new Date(`${v}T10:00:00`).getTime();
      if(until < Date.now()){ const e = document.getElementById('srErr'); e.textContent = 'Pick a revisit date in the future.'; e.classList.add('show'); return; }
    }
  }
  closeStageReasonModal();
  if(d.leadIds){ bulkApplyStage(d.leadIds, d.stageId, { reason, until }); return; }
  changeStage(d.leadId, d.stageId, { reason, until });
  showToast(d.kind === 'lost' ? 'Moved to Lost' : 'Moved to On hold');
}

// ── The AI's verdict on a lead: accept, dismiss, undo, re-check ──
function patchLeadAi(l, fields){
  // Local copy first so the page updates now; the snapshot confirms.
  l.ai = l.ai || {};
  Object.entries(fields).forEach(([path, value]) => {
    const parts = path.split('.').slice(1);
    let o = l.ai;
    parts.slice(0, -1).forEach(p => { o[p] = o[p] || {}; o = o[p]; });
    o[parts[parts.length-1]] = value;
  });
  if(window.crmFirebase && window.crmFirebase.updateLeadAi) window.crmFirebase.updateLeadAi(l.id, fields);
}
function acceptAiSuggestion(id){
  const l = leads.find(x=>x.id===id);
  const s = l && l.ai && l.ai.suggestion;
  if(!s) return;
  const stageId = stageIdForKey(s.stage);
  if(!stageId) return;
  patchLeadAi(l, { 'ai.suggestion': null });
  changeStage(id, stageId, { reasonHint: l.ai.lostReason || l.ai.holdReason, untilHint: l.ai.holdUntil });
}
function dismissAiSuggestion(id){
  const l = leads.find(x=>x.id===id);
  const s = l && l.ai && l.ai.suggestion;
  if(!s) return;
  patchLeadAi(l, { 'ai.suggestion': null, [`ai.dismissed.${s.stage}`]: Date.now() });
  addHistory(l, 'field', `Dismissed the AI's suggestion to move to <b>${escapeHtml((window.crmPipeline && window.crmPipeline.stageDef(s.stage) || {}).name || s.stage)}</b>`);
  refreshAll();
  if(currentDetailId===id){ renderStandSection(l); renderHistory(l); }
}
function undoAiMove(id){
  const l = leads.find(x=>x.id===id);
  const m = l && l.ai && l.ai.lastMove;
  if(!m) return;
  const back = m.fromStageId && stageById(m.fromStageId) ? m.fromStageId : stageIdForKey(m.from);
  if(!back) return;
  // Remember the undo so the AI does not make the same move again without a new message.
  patchLeadAi(l, { 'ai.lastMove': null, [`ai.dismissed.${m.to}`]: Date.now() });
  changeStage(id, back, { reason: l.lostReason || l.holdReason || 'other' });
  showToast('Move undone');
}
let recheckingIds = new Set();
async function recheckLead(id){
  if(recheckingIds.has(id)) return;
  recheckingIds.add(id);
  const l = leads.find(x=>x.id===id);
  if(l && currentDetailId===id) renderStandSection(l);
  try{
    const idToken = await window.crmAuth.getIdToken();
    const res = await fetch('/api/tailortalk?action=ai-lead', { method:'POST', headers:{ 'Content-Type':'application/json', 'Authorization':'Bearer '+idToken }, body: JSON.stringify({ leadId: id }) });
    const data = await res.json().catch(()=>({}));
    if(!res.ok || data.ok === false) showToast(data.error ? `Re-check failed: ${data.error}` : (data.skipped ? `Skipped: ${data.skipped}` : 'Re-check failed'));
    else showToast(data.moved ? `🤖 Moved to ${(window.crmPipeline.stageDef(data.moved.to)||{}).name}` : data.suggested ? '🤖 AI has a suggestion' : '🤖 Checked — no change');
  } catch(e){
    showToast('Re-check failed — check your connection');
  } finally {
    recheckingIds.delete(id);
    const cur = leads.find(x=>x.id===id);
    if(cur && currentDetailId===id) renderStandSection(cur);
  }
}
function markHandledUi(id, what){
  const l = leads.find(x=>x.id===id);
  if(!l) return;
  addHistory(l, 'followed-up', `Handled: <b>${escapeHtml(what)}</b>`);
  l.updatedAt = Date.now();
  l.updatedBy = currentUserEmail || l.updatedBy || null;
  l.lastActionType = 'signal-handled';
  persistLead(l);
  refreshAll();
  if(currentDetailId===id){ renderStandSection(l); renderTtSection(l); renderHistory(l); }
  showToast('✓ Marked handled');
}
function markVisitedUi(id){
  const stageId = stageIdForKey('visit_done');
  if(stageId) changeStage(id, stageId);
}

// ── "Where this lead stands" on the lead page ──
function renderStandSection(l){
  const sec = document.getElementById('dpStandSec');
  const el = document.getElementById('dpStand');
  if(!sec || !el) return;
  if(isBusinessLead(l)){ sec.hidden = true; return; }
  sec.hidden = false;
  const P = window.crmPipeline;
  const ai = l.ai || {};
  const stage = stageById(l.stageId);
  const kind = stageKindOfId(l.stageId);
  const parts = [];

  const rule = stage ? stageRuleOf(stage) : '';
  let why = '';
  if(kind === 'lost' && l.lostReason) why = P.LOST_REASONS[l.lostReason] || l.lostReason;
  if(kind === 'hold') why = [l.holdReason && P.HOLD_REASONS[l.holdReason], l.holdUntil && `revisit ${fmtDue(l.holdUntil)}`].filter(Boolean).join(' · ');
  const age = P.stageAge(l, stages);
  const ageText = age ? (age.days === 0 ? 'since today' : `for ${age.days} day${age.days === 1 ? '' : 's'}`) : '';
  const ageCls = age && age.over ? (age.farOver ? ' far' : ' over') : '';
  parts.push(`<div class="st-head">
    <div class="st-stage"><span class="kcol-dot" style="background:${stage ? stage.color : '#999'}"></span><b>${escapeHtml(stage ? stage.name : 'No column')}</b>${ageText ? `<span class="st-age${ageCls}" title="${age && age.target != null ? escapeHtml('Usually ' + age.target + ' days or fewer') : ''}">${ageText}</span>` : ''}${rule ? `<span class="st-rule">${escapeHtml(rule)}</span>` : ''}</div>
    ${why ? `<div class="st-why">${escapeHtml(why)}</div>` : ''}
    ${milestoneTrailHtml(l)}
  </div>`);
  const mention = myOpenMention(l);
  if(mention){
    parts.push(`<div class="st-item mention">
      <div class="st-item-main"><div class="st-item-t">@ ${escapeHtml(window.crmMentions.displayName(mention.by || '') || 'Someone')} mentioned you</div><div class="st-item-d">“${escapeHtml(mention.text || '')}” · ${timeAgo(mention.at)}</div></div>
      <div class="st-item-acts"><button type="button" class="tt-btn" onclick="markMentionDone('${l.id}')">Done</button></div>
    </div>`);
  }

  const step = nextStepOf(l);
  const stepIsTeam = step && (step.cls === 'team' || step.cls === 'overdue');
  if(step) parts.push(`<div class="st-step ${step.cls}${stepIsTeam ? ' with-acts' : ''}"><span class="st-label">Next step</span><span>${escapeHtml(step.text)}${step.due ? `<span class="st-due"> · ${escapeHtml(fmtDue(step.due))}</span>` : ''}</span>${stepIsTeam ? `<span class="st-item-acts"><button type="button" class="tt-btn" onclick="openFollowUpLogModal('${l.id}')">Log follow-up</button><button type="button" class="tt-btn quiet" onclick="markHandledUi('${l.id}', ${escapeHtml(JSON.stringify(step.text))})">Done</button></span>` : ''}</div>`);
  if(ai.visit && (ai.visit.at || ai.visit.status !== 'none')){
    const vs = { requested:'Asked for', scheduled:'Agreed', done:'Done', cancelled:'Cancelled', none:'' }[ai.visit.status] || '';
    parts.push(`<div class="st-row"><span class="st-label">Site visit</span><span>${escapeHtml([vs, ai.visit.property, ai.visit.at && fmtDue(ai.visit.at)].filter(Boolean).join(' · '))}</span></div>`);
  }

  // Everything that needs a person, with the action that settles it.
  const attn = attentionFor(l).filter(a => a.key !== 'ai_suggestion' && !(stepIsTeam && STEP_KEYS.has(a.key)));
  if(attn.length){
    parts.push(`<div class="st-attn">${attn.map(a => {
      const btns = [];
      if(a.key === 'visit_outcome') btns.push(`<button type="button" class="tt-btn" onclick="markVisitedUi('${l.id}')">They visited</button>`);
      if(a.key.startsWith('signal:') || ['waiting_for_team','escalated','flagged','promise_overdue','team_owes','window_closing','followup_overdue','visit_unscheduled','feedback_due','negotiation_stalled','hold_due','lead_silent','visit_outcome'].includes(a.key)) btns.push(`<button type="button" class="tt-btn" onclick="openFollowUpLogModal('${l.id}')">Log follow-up</button>`);
      if(a.key === 'stale') btns.push(`<button type="button" class="tt-btn" onclick="changeStage('${l.id}','${stageIdForKey('lost')}')">Close as lost</button>`);
      btns.push(`<button type="button" class="tt-btn quiet" onclick="markHandledUi('${l.id}', ${escapeHtml(JSON.stringify(a.label))})">Handled</button>`);
      return `<div class="st-item ${a.severity}">
        <div class="st-item-main"><div class="st-item-t">${escapeHtml(a.label)}</div>${a.detail ? `<div class="st-item-d">${escapeHtml(a.detail)}</div>` : ''}</div>
        <div class="st-item-acts">${btns.join('')}</div>
      </div>`;
    }).join('')}</div>`);
  }

  if(ai.suggestion && ai.suggestion.stage && stageKeyOfId(l.stageId) !== ai.suggestion.stage){
    const def = P.stageDef(ai.suggestion.stage);
    parts.push(`<div class="st-suggest">
      <div><b>🤖 AI suggests: ${escapeHtml(def ? def.name : ai.suggestion.stage)}</b><div class="st-item-d">${escapeHtml(ai.suggestion.evidence || '')}${ai.suggestion.why ? ` · not moved automatically: ${escapeHtml(ai.suggestion.why)}` : ''}</div></div>
      <div class="st-item-acts"><button type="button" class="tt-btn" onclick="acceptAiSuggestion('${l.id}')">Move</button><button type="button" class="tt-btn quiet" onclick="dismissAiSuggestion('${l.id}')">Dismiss</button></div>
    </div>`);
  }
  if(ai.lastMove && Date.now() - ai.lastMove.at < 7*86400000 && l.stageId === stageIdForKey(ai.lastMove.to)){
    const from = P.stageDef(ai.lastMove.from), to = P.stageDef(ai.lastMove.to);
    parts.push(`<div class="st-moved">
      <div>🤖 Moved from <b>${escapeHtml(from ? from.name : ai.lastMove.from)}</b> to <b>${escapeHtml(to ? to.name : ai.lastMove.to)}</b> ${timeAgo(ai.lastMove.at)}<div class="st-item-d">${escapeHtml(ai.lastMove.evidence || '')}</div></div>
      <div class="st-item-acts"><button type="button" class="tt-btn quiet" onclick="undoAiMove('${l.id}')">Undo</button></div>
    </div>`);
  }

  const checking = recheckingIds.has(l.id);
  const canRead = isTtLead(l) || (l.noteCount || 0) > 0;
  const read = ai.at ? `AI read this lead ${timeAgo(ai.at)}${ai.confidence ? ' · ' + ai.confidence + ' confidence' : ''}${ai.error ? ' · last read failed: ' + escapeHtml(ai.error) : ''}` : (canRead ? 'Not read by the AI yet' : 'No chat or notes for the AI to read');
  parts.push(`<div class="st-foot"><span>${read}</span>${canRead ? `<button type="button" class="tt-btn quiet" ${checking?'disabled':''} onclick="recheckLead('${l.id}')">${checking ? 'Reading…' : 'Re-check'}</button>` : ''}</div>`);
  el.innerHTML = parts.join('');
}

// ═══════ ADD / EDIT LEAD MODAL ═══════
function renderEnquiryTypeOptions(selected){
  const sel = document.getElementById('lmEnquiryType');
  const opts = enquiryTypes.map(t=>`<option value="${escapeHtml(t)}">${escapeHtml(t)}</option>`).join('');
  sel.innerHTML = `<option value="">Select type…</option>${opts}<option value="__add_new__">+ Add new type…</option>`;
  sel.value = selected && enquiryTypes.includes(selected) ? selected : '';
  updatePropertyFieldMode();
}
function renderStageOptions(selected){
  const sel = document.getElementById('lmStage');
  if(!stages.length){ sel.innerHTML = '<option value="">No stages yet</option>'; return; }
  sel.innerHTML = stages.map(s=>`<option value="${s.id}">${escapeHtml(s.name)}</option>`).join('');
  sel.value = (selected && stages.some(s=>s.id===selected)) ? selected : stages[0].id;
}
function hideNewTypeRow(){
  document.getElementById('lmNewTypeRow').style.display='none';
  document.getElementById('lmNewEnquiryType').value='';
}
function onEnquiryTypeSelectChange(){
  const sel = document.getElementById('lmEnquiryType');
  if(sel.value === '__add_new__'){
    document.getElementById('lmNewTypeRow').style.display='flex';
    document.getElementById('lmNewEnquiryType').focus();
  } else {
    hideNewTypeRow();
  }
  updatePropertyFieldMode();
}
function confirmAddEnquiryType(){
  const inp = document.getElementById('lmNewEnquiryType');
  const val = inp.value.trim();
  if(!val) return;
  const existing = enquiryTypes.find(t=>t.toLowerCase()===val.toLowerCase());
  if(!existing){
    enquiryTypes.push(val);
    window.crmFirebase.saveEnquiryTypes(enquiryTypes);
  }
  renderEnquiryTypeOptions(existing || val);
  hideNewTypeRow();
}

// Sent Details in the add/edit modal is a tri-state-free Yes/No pill mirroring
// the detail panel's toggle — held in this draft variable while the modal is
// open, and only written onto the lead on save.
let lmDetailsSent = false;
function renderLeadModalDetailsSent(){
  const wrap = document.getElementById('lmDetailsSentToggle');
  if(!wrap) return;
  wrap.querySelector('.yes').classList.toggle('active', lmDetailsSent);
  wrap.querySelector('.no').classList.toggle('active', !lmDetailsSent);
  wrap.classList.toggle('sent', lmDetailsSent);
  wrap.classList.toggle('not-sent', !lmDetailsSent);
}
function setLeadModalDetailsSent(value){
  lmDetailsSent = value === true;
  renderLeadModalDetailsSent();
}

// ═══════ PROPERTY COMBOBOX (Property Enquiry only) ═══════
// The property list is the union of two sources, so it's always complete
// without anyone having to curate it: every property already used by a
// Property Enquiry lead, plus the ones explicitly added here (persisted in
// settings/{tenant}.properties, which is what keeps a brand-new property
// selectable before its first lead has even been saved).
let savedProperties = [];
window.applyPropertiesSnapshot = function(list){
  savedProperties = Array.isArray(list) ? list : [];
};
function isPropertyEnquiryType(t){ return String(t || '').trim().toLowerCase() === 'property enquiry'; }
function isSellerEnquiryType(t){ return String(t || '').trim().toLowerCase() === 'seller listing'; }
// Either signal is enough — see the "Sellers & owners" focus filter above for why both exist.
function isSellerLead(l){ return isSellerEnquiryType(l.enquiryType) || !!(l.ai && (l.ai.intent==='sell' || l.ai.intent==='rent_out')); }
function knownProperties(){
  const byKey = new Map();
  const add = (v) => {
    const val = String(v || '').trim();
    const key = val.toLowerCase();
    if(key && !byKey.has(key)) byKey.set(key, val);
  };
  savedProperties.forEach(add);
  leads.forEach(l => { if(isPropertyEnquiryType(l.enquiryType)) add(l.propertyInterest); });
  return Array.from(byKey.values()).sort((a,b)=>a.localeCompare(b));
}
// Called on save so a property typed in via "add on the fly" is selectable
// from the dropdown next time, even before its lead syncs back.
function rememberProperty(enquiryType, value){
  if(!isPropertyEnquiryType(enquiryType)) return;
  const val = String(value || '').trim();
  if(!val) return;
  if(savedProperties.some(p => String(p).trim().toLowerCase() === val.toLowerCase())) return;
  savedProperties = savedProperties.concat([val]);
  if(window.crmFirebase && window.crmFirebase.saveProperties) window.crmFirebase.saveProperties(savedProperties);
}

let propertyPopOpen = false;
let propertyPopItems = [];
let propertyPopIndex = -1;

function updatePropertyFieldMode(){
  const isProp = isPropertyEnquiryType(document.getElementById('lmEnquiryType').value);
  const combo = document.getElementById('lmInterestCombo');
  const input = document.getElementById('lmInterest');
  const hint = document.getElementById('lmInterestHint');
  const label = document.getElementById('lmInterestLabel');
  if(!combo) return;
  combo.classList.toggle('is-combo', isProp);
  input.placeholder = isProp ? 'Search properties, or type a new one…' : 'e.g. 3BHK in Nanganallur';
  label.textContent = isProp ? 'Property *' : 'Property / Locality *';
  hint.textContent = isProp ? `${knownProperties().length} propert${knownProperties().length===1?'y':'ies'} on file — pick one or type a new name to add it.` : '';
  if(!isProp) closePropertyPop();
}
function propertyMatches(query){
  const q = String(query || '').trim().toLowerCase();
  const all = knownProperties();
  if(!q) return all;
  return all.filter(p => p.toLowerCase().includes(q));
}
function renderPropertyPop(){
  const pop = document.getElementById('lmInterestPop');
  const input = document.getElementById('lmInterest');
  const typed = input.value.trim();
  const matches = propertyMatches(typed).slice(0, 60);
  const exact = matches.some(p => p.toLowerCase() === typed.toLowerCase());

  propertyPopItems = matches.map(p => ({ kind:'pick', value:p }));
  if(typed && !exact) propertyPopItems.unshift({ kind:'add', value:typed });

  if(!propertyPopItems.length){
    pop.innerHTML = '<div class="combo-empty">No properties yet — type a name to add the first one.</div>';
    return;
  }
  pop.innerHTML = propertyPopItems.map((it,i)=>{
    const active = i===propertyPopIndex ? ' at' : '';
    return it.kind === 'add'
      ? `<button type="button" class="combo-opt add${active}" role="option" onclick="pickProperty(${i})">＋ Add “${escapeHtml(it.value)}” as a new property</button>`
      : `<button type="button" class="combo-opt${active}" role="option" onclick="pickProperty(${i})">${escapeHtml(it.value)}</button>`;
  }).join('');
  const activeEl = pop.querySelector('.combo-opt.at');
  if(activeEl) activeEl.scrollIntoView({ block:'nearest' });
  positionComboPop();
}
// The pop is `position:fixed` because .modal-body is a scrollport — as an
// absolutely positioned child it was clipped to whatever slice of the 238px
// list happened to fit below the field, which on the Add Lead form is usually
// one or two rows. Fixed means it has to be placed by hand, and flipped above
// the field when there is no room beneath it.
function positionComboPop(){
  const pop = document.getElementById('lmInterestPop');
  const combo = document.getElementById('lmInterestCombo');
  if(!pop || !combo || !propertyPopOpen) return;
  const r = combo.getBoundingClientRect();
  const pad = 8;
  pop.style.width = r.width + 'px';
  pop.style.left = Math.max(pad, Math.min(r.left, innerWidth - r.width - pad)) + 'px';
  const below = innerHeight - r.bottom - pad;
  const above = r.top - pad;
  if(below < 140 && above > below){
    pop.style.maxHeight = Math.min(238, above) + 'px';
    pop.style.top = Math.max(pad, r.top - Math.min(238, above) - 6) + 'px';
  } else {
    pop.style.maxHeight = Math.min(238, below) + 'px';
    pop.style.top = (r.bottom + 6) + 'px';
  }
}
addEventListener('resize', positionComboPop);
addEventListener('scroll', positionComboPop, true);
function openPropertyPop(){
  if(!isPropertyEnquiryType(document.getElementById('lmEnquiryType').value)) return;
  propertyPopOpen = true;
  document.getElementById('lmInterestCombo').classList.add('open');
  document.getElementById('lmInterest').setAttribute('aria-expanded','true');
  renderPropertyPop();
}
function closePropertyPop(){
  propertyPopOpen = false;
  propertyPopIndex = -1;
  const combo = document.getElementById('lmInterestCombo');
  if(combo) combo.classList.remove('open');
  const input = document.getElementById('lmInterest');
  if(input) input.setAttribute('aria-expanded','false');
}
function togglePropertyPop(){
  if(propertyPopOpen) closePropertyPop();
  else { document.getElementById('lmInterest').focus(); openPropertyPop(); }
}
function onPropertyFocus(){ openPropertyPop(); }
function onPropertyInput(){ propertyPopIndex = -1; openPropertyPop(); }
function pickProperty(i){
  const it = propertyPopItems[i];
  if(!it) return;
  document.getElementById('lmInterest').value = it.value;
  closePropertyPop();
  document.getElementById('lmInterest').focus();
}
function onPropertyKeydown(e){
  if(!isPropertyEnquiryType(document.getElementById('lmEnquiryType').value)) return;
  if(e.key === 'ArrowDown' || e.key === 'ArrowUp'){
    e.preventDefault();
    if(!propertyPopOpen){ openPropertyPop(); return; }
    if(!propertyPopItems.length) return;
    propertyPopIndex = e.key === 'ArrowDown'
      ? (propertyPopIndex + 1) % propertyPopItems.length
      : (propertyPopIndex - 1 + propertyPopItems.length) % propertyPopItems.length;
    renderPropertyPop();
  } else if(e.key === 'Enter'){
    if(propertyPopOpen && propertyPopIndex >= 0){ e.preventDefault(); pickProperty(propertyPopIndex); }
  } else if(e.key === 'Escape'){
    if(propertyPopOpen){ e.stopPropagation(); closePropertyPop(); }
  }
}

function openAddLeadModal(){
  lModalMode='add'; lModalEditId=null;
  document.getElementById('lmTitle').textContent='Add New Lead';
  document.getElementById('lmChannel').value='';
  renderStageOptions('');
  document.getElementById('lmName').value='';
  document.getElementById('lmPhone').value='';
  document.getElementById('lmEmail').value='';
  renderEnquiryTypeOptions('');
  hideNewTypeRow();
  document.getElementById('lmInterest').value='';
  document.getElementById('lmBudget').value='';
  document.getElementById('lmFollowUpDate').value='';
  document.getElementById('lmFollowUpTime').value='';
  document.getElementById('lmNotes').value='';
  setLeadModalDetailsSent(false);
  lmModalContactAt = Date.now();
  document.getElementById('lmContactTimeDisplay').textContent = new Date(lmModalContactAt).toLocaleString();
  document.getElementById('lmErr').classList.remove('show');
  document.getElementById('lModal').classList.add('open');
}
function openEditLeadModal(id){
  const l = leads.find(x=>x.id===id);
  if(!l) return;
  lModalMode='edit'; lModalEditId=id;
  document.getElementById('lmTitle').textContent='Edit Lead';
  document.getElementById('lmChannel').value=l.channel||'';
  renderStageOptions(l.stageId||'');
  document.getElementById('lmName').value=l.name||'';
  document.getElementById('lmPhone').value=l.phone||'';
  document.getElementById('lmEmail').value=l.email||'';
  renderEnquiryTypeOptions(l.enquiryType||'');
  hideNewTypeRow();
  document.getElementById('lmInterest').value=l.propertyInterest||'';
  document.getElementById('lmBudget').value=l.budget||'';
  const fu = l.followUpAt ? new Date(l.followUpAt) : null;
  document.getElementById('lmFollowUpDate').value = fu ? toDateInputValue(fu) : '';
  document.getElementById('lmFollowUpTime').value = fu ? toTimeInputValue(fu) : '';
  document.getElementById('lmNotes').value='';
  setLeadModalDetailsSent(l.detailsSent === true);
  lmModalContactAt = l.contactAt || l.createdAt || Date.now();
  document.getElementById('lmContactTimeDisplay').textContent = new Date(lmModalContactAt).toLocaleString();
  document.getElementById('lmErr').classList.remove('show');
  lmOpenValues = { name: l.name||'', propertyInterest: l.propertyInterest||'', budget: l.budget||'', enquiryType: document.getElementById('lmEnquiryType').value||'' };
  document.getElementById('lModal').classList.add('open');
}
// What the TailorTalk-shared fields showed when Edit opened. TailorTalk may update the lead
// while the form sits open; a field the person didn't touch must take that newer value, not
// write the old one back (and take the field over) on save.
let lmOpenValues = null;
function closeLeadModal(){
  document.getElementById('lModal').classList.remove('open');
  hideNewTypeRow();
  closePropertyPop();
}
// Future-date rule: with a time given, the exact moment must be after now;
// with only a date given, it must be strictly after today (a bare "today"
// reads as already past since we can't know which part of today they meant).
function computeFollowUpAt(dateStr, timeStr){
  if(timeStr){
    const dt = new Date(`${dateStr}T${timeStr}:00`);
    if(isNaN(dt.getTime()) || dt.getTime() <= Date.now()){
      return { error: 'Follow-up date & time must be in the future.' };
    }
    return { value: dt.getTime() };
  }
  if(dateStr <= toDateInputValue(new Date())){
    return { error: 'Follow-up date must be a future date (add a time if you mean later today).' };
  }
  return { value: new Date(`${dateStr}T00:00:00`).getTime() };
}
// Reads + validates the add/edit modal into one plain object. Returns null
// (after showing the inline error) when anything is missing, so every caller —
// save, and the duplicate-merge path — validates identically.
function readLeadForm(){
  const errBox = document.getElementById('lmErr');
  const showErr = (msg) => { errBox.textContent = msg; errBox.classList.add('show'); };
  errBox.classList.remove('show');

  const form = {
    channel: document.getElementById('lmChannel').value,
    stageId: document.getElementById('lmStage').value || (stages.length ? stages[0].id : null),
    name: document.getElementById('lmName').value.trim(),
    phone: document.getElementById('lmPhone').value.trim(),
    email: document.getElementById('lmEmail').value.trim(),
    enquiryType: document.getElementById('lmEnquiryType').value,
    propertyInterest: document.getElementById('lmInterest').value.trim(),
    budget: document.getElementById('lmBudget').value.trim(),
    detailsSent: lmDetailsSent === true,
    noteText: document.getElementById('lmNotes').value.trim(),
    followUpAt: null
  };

  if(!form.channel){ showErr('Please select a channel.'); return null; }
  if(!form.name){ showErr('Name is required.'); return null; }
  if(!form.phone){ showErr('Phone number is required.'); return null; }
  if(!form.enquiryType || form.enquiryType==='__add_new__'){ showErr('Please select an enquiry type.'); return null; }
  if(!form.propertyInterest){ showErr('Property / Locality is required.'); return null; }

  const followUpDate = document.getElementById('lmFollowUpDate').value;
  const followUpTime = document.getElementById('lmFollowUpTime').value;
  if(followUpDate){
    const r = computeFollowUpAt(followUpDate, followUpTime);
    if(r.error){ showErr(r.error); return null; }
    form.followUpAt = r.value;
  }
  return form;
}

// Field-by-field difference between a lead and a submitted form. Each entry
// carries BOTH the escaped history sentence and the raw label/old/new, so the
// same diff drives the history log, the duplicate modal's preview, and the
// "what changed" note — they can never describe different things.
function leadFormDiffs(l, form){
  const diffs = [];
  const push = (type, label, oldVal, newVal) => {
    if((oldVal||'') === (newVal||'')) return;
    diffs.push({
      type, label, oldVal: oldVal||'', newVal: newVal||'',
      text: `${label} changed from <b>${escapeHtml(oldVal||'—')}</b> to <b>${escapeHtml(newVal||'—')}</b>`
    });
  };
  push('field', 'Channel', channelLabel(l.channel), channelLabel(form.channel));
  push('field', 'Name', l.name, form.name);
  push('field', 'Phone', l.phone, form.phone);
  push('field', 'Email', l.email, form.email);
  push('field', 'Enquiry type', l.enquiryType, form.enquiryType);
  push('field', 'Property / Locality', l.propertyInterest, form.propertyInterest);
  push('field', 'Budget', l.budget, form.budget);

  const oldStage = stageById(l.stageId), newStage = stageById(form.stageId);
  push('stage', 'Stage', oldStage ? oldStage.name : '', newStage ? newStage.name : '');

  const flag = v => v === true ? 'Yes' : 'No';
  push('details-sent', 'Sent details', flag(l.detailsSent), flag(form.detailsSent));

  const fmtFu = ts => ts ? new Date(ts).toLocaleString([], { month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' }) : '';
  if((l.followUpAt||null) !== (form.followUpAt||null)){
    diffs.push(form.followUpAt
      ? { type:'followup', label:'Next follow-up', oldVal: fmtFu(l.followUpAt), newVal: fmtFu(form.followUpAt),
          text:`Next follow-up ${l.followUpAt?'changed to':'set for'} <b>${fmtFu(form.followUpAt)}</b>` }
      : { type:'followup-removed', label:'Next follow-up', oldVal: fmtFu(l.followUpAt), newVal: '',
          text:'Follow-up removed' });
  }
  return diffs;
}

// Writes a validated form onto an existing lead and logs every change to its
// history. Shared by the Edit modal and the duplicate-merge path.
function applyLeadForm(l, form, now){
  rememberProperty(form.enquiryType, form.propertyInterest);
  const diffs = leadFormDiffs(l, form);
  // A shared field someone changes here stops following TailorTalk (see TAILORTALK above).
  if(isTtLead(l)){
    const hold = { ...(l.ttHold||{}) };
    TT_FOLLOW_FIELDS.forEach(f => { if((l[f]||'') !== (form[f]||'')) hold[f] = true; });
    l.ttHold = hold;
  }
  const oldStageId = l.stageId;
  const stageChanged = oldStageId !== form.stageId;

  l.channel=form.channel; l.stageId=form.stageId; l.name=form.name; l.phone=form.phone;
  l.email=form.email; l.enquiryType=form.enquiryType; l.propertyInterest=form.propertyInterest;
  l.budget=form.budget; l.detailsSent=form.detailsSent;
  l.contactAt = l.contactAt || lmModalContactAt || now;
  if((l.followUpAt||null) !== (form.followUpAt||null)){ l.followUpBy = currentUserEmail || 'team'; l.followUpSetAt = now; l.followUpNote = null; }
  l.followUpAt = form.followUpAt;
  l.updatedAt = now;
  l.updatedBy = currentUserEmail || null;
  l.notes = l.notes || [];
  // See changeStage() for why these are stamped — same "today" bucketing need.
  if(stageChanged){
    l.prevStageId = oldStageId; l.stageChangedAt = now; l.stageChangedBy = currentUserEmail || 'team';
    markReached(l, form.stageId, now);
    const toKind = stageKindOfId(form.stageId);
    if(toKind === 'lost' && !l.lostReason) l.lostReason = 'other';
    if(toKind !== 'lost') l.lostReason = null;
    if(toKind !== 'hold'){ l.holdReason = null; l.holdUntil = null; }
  }
  l.lastActionType = stageChanged ? 'stage' : (form.noteText ? 'note' : 'field');
  diffs.forEach(d => addHistory(l, d.type, d.text));
  return diffs;
}

function saveLeadModal(){
  const form = readLeadForm();
  if(!form) return;

  if(lModalMode==='add'){
    // A second lead on the same phone number is never created silently — the
    // agent decides between abandoning the entry and folding it into the one
    // that already exists (see openDuplicateModal / confirmDuplicateUpdate).
    const existing = findLeadByPhone(form.phone, null);
    if(existing){ openDuplicateModal(existing, form); return; }
    createLeadFromForm(form);
  } else {
    const l = leads.find(x=>x.id===lModalEditId);
    if(l){
      const now = Date.now();
      if(isTtLead(l) && lmOpenValues){
        TT_FOLLOW_FIELDS.forEach(f => { if((form[f]||'') === (lmOpenValues[f]||'')) form[f] = l[f] || ''; });
      }
      applyLeadForm(l, form, now);
      if(form.noteText) logNote(l, { id:'n'+now, text: form.noteText, createdAt: now, by: currentUserEmail || null });
      showToast('✓ Enquiry updated');
      persistLead(l);
    }
  }
  closeLeadModal();
  refreshAll();
  if(lModalMode==='edit') openDetail(lModalEditId);
}

function createLeadFromForm(form){
  const now = Date.now();
  const l = {
    id: 'lead_'+now,
    channel: form.channel, name: form.name, phone: form.phone, email: form.email,
    enquiryType: form.enquiryType, propertyInterest: form.propertyInterest, budget: form.budget,
    source: 'manual',
    stageId: form.stageId,
    notes: [],
    history: [],
    detailsSent: form.detailsSent,
    contactAt: lmModalContactAt || now,
    followUpAt: form.followUpAt,
    createdAt: now,
    updatedAt: now,
    createdBy: currentUserEmail || null,
    updatedBy: currentUserEmail || null,
    // Denormalized for the Dashboard's "today" metrics (computeDashboardMetrics
    // in dashboardMetrics.js) — lets it tell an untouched brand-new lead apart
    // from one that already got a first note, with zero extra reads/writes.
    lastActionType: form.noteText ? 'note' : 'created'
  };
  markReached(l, stageIdForKey('new'), now);
  markReached(l, form.stageId, now);
  // Brand-new lead: the subcollection security rule checks the PARENT lead's
  // tenantId, so the parent doc must exist before we write its notes/history.
  // Create the parent first, then log the 'created' event + optional first
  // note, then re-save the parent so its lastNote/noteCount persist.
  const createdEvent = { id:'h'+now+Math.random().toString(36).slice(2,7), type:'created', text:`Lead added via <b>${escapeHtml(channelLabel(form.channel))}</b>`, at: now, by: currentUserEmail || null };
  l.history = [createdEvent];
  const firstNote = form.noteText ? { id:'n'+now, text: form.noteText, createdAt: now, by: currentUserEmail || null } : null;
  if(firstNote){ l.notes = [firstNote]; recomputeNoteMeta(l); }
  rememberProperty(form.enquiryType, form.propertyInterest);
  leads.unshift(l);
  showToast('✓ Enquiry saved');
  Promise.resolve(window.crmFirebase.saveLead(l)).then(() => {
    window.crmFirebase.saveHistory(l.id, createdEvent);
    if(firstNote) window.crmFirebase.saveNote(l.id, firstNote);
    if(firstNote) window.crmFirebase.saveLead(l); // persist lastNote/noteCount
  });
}

// ═══════ DUPLICATE LEAD (same phone number) ═══════
let dupExistingId = null;
let dupPendingForm = null;

// Merging into an existing lead is a PATCH, not a replace. The Add form opens
// on defaults — first stage, Sent Details = No, no follow-up, blank optional
// fields — and leaving one of those alone means "I have no opinion", not
// "clear it". Applying them literally would drag a Site-Visit lead back to
// New and delete a scheduled follow-up, so untouched defaults defer to
// whatever the existing lead already has. A value the agent actually changed
// always wins.
function mergeFormOntoLead(l, form){
  const patched = { ...form };
  if(!patched.email) patched.email = l.email || '';
  if(!patched.budget) patched.budget = l.budget || '';
  const defaultStageId = stages.length ? stages[0].id : null;
  if(patched.stageId === defaultStageId && l.stageId) patched.stageId = l.stageId;
  if(patched.detailsSent === false && l.detailsSent === true) patched.detailsSent = true;
  if(patched.followUpAt === null && l.followUpAt) patched.followUpAt = l.followUpAt;
  return patched;
}

function openDuplicateModal(existing, form){
  dupExistingId = existing.id;
  dupPendingForm = mergeFormOntoLead(existing, form);
  form = dupPendingForm;

  const stage = stageById(existing.stageId);
  const rows = [
    ['Name', existing.name],
    ['Phone', existing.phone],
    ['Email', existing.email],
    ['Channel', existing.channel ? channelLabel(existing.channel) : ''],
    ['Enquiry type', existing.enquiryType],
    ['Property / Locality', existing.propertyInterest],
    ['Budget', existing.budget],
    ['Stage', stage ? stage.name : ''],
    ['Sent details', existing.detailsSent === true ? 'Yes' : 'No'],
    ['Added', existing.createdAt ? new Date(existing.createdAt).toLocaleString() : ''],
    ['Added by', existing.createdBy || ''],
    ['Last updated', existing.updatedAt ? new Date(existing.updatedAt).toLocaleString() : ''],
    ['Last updated by', existing.updatedBy || '']
  ];
  document.getElementById('dupExistingCard').innerHTML = rows
    .map(([k,v]) => `<div class="dup-kv"><span class="dup-k">${escapeHtml(k)}</span><span class="dup-v">${escapeHtml(v || '—')}</span></div>`)
    .join('');

  const diffs = leadFormDiffs(existing, form);
  document.getElementById('dupChangeList').innerHTML = diffs.length
    ? diffs.map(d => `<div class="dup-change">
        <span class="dup-change-label">${escapeHtml(d.label)}</span>
        <span class="dup-change-old">${escapeHtml(d.oldVal || '—')}</span>
        <span class="dup-change-arrow">→</span>
        <span class="dup-change-new">${escapeHtml(d.newVal || '—')}</span>
      </div>`).join('') + (form.noteText ? `<div class="dup-change-note">Plus a new note: “${escapeHtml(form.noteText)}”</div>` : '')
    : `<div class="dup-change-none">No field changes — the details you typed match the existing lead.${form.noteText ? ' Your note will still be added.' : ''}</div>`;

  document.getElementById('dupModal').classList.add('open');
}
function closeDupModal(){
  document.getElementById('dupModal').classList.remove('open');
  dupExistingId = null;
  dupPendingForm = null;
}
function openExistingDuplicate(){
  const id = dupExistingId;
  closeDupModal();
  closeLeadModal();
  if(id) openDetail(id);
}
// Merge: every changed field lands in the lead's history AND is summarised in
// one extra note appended alongside the existing ones, so the change is
// readable from the notes thread without opening the history log.
function confirmDuplicateUpdate(){
  const l = leads.find(x=>x.id===dupExistingId);
  const form = dupPendingForm;
  if(!l || !form){ closeDupModal(); return; }

  const now = Date.now();
  const diffs = applyLeadForm(l, form, now);
  const changeSummary = diffs.map(d => `${d.label}: ${d.oldVal || '—'} → ${d.newVal || '—'}`).join(', ');
  logNote(l, {
    id: 'n'+now,
    text: changeSummary
      ? `Lead details updated — Changes: ${changeSummary}`
      : 'Lead details updated — no field changes',
    createdAt: now,
    by: currentUserEmail || null
  });
  if(form.noteText){
    logNote(l, { id:'n'+(now+1), text: form.noteText, createdAt: now+1, by: currentUserEmail || null });
  }
  persistLead(l);

  const id = l.id;
  closeDupModal();
  closeLeadModal();
  refreshAll();
  showToast('✓ Existing lead updated');
  openDetail(id);
}

function deleteLead(id){
  const l = leads.find(x=>x.id===id);
  if(!l) return;
  if(!confirm(`Delete lead "${l.name}"? This cannot be undone.`)) return;
  leads = leads.filter(x=>x.id!==id);
  closeDetail();
  refreshAll();
  showToast('Lead deleted');
  window.crmFirebase.deleteLead(id);
}

// ═══════ EXPORT ═══════
function isToday(ts){
  if(!ts) return false;
  const d = new Date(ts), now = new Date();
  return d.getFullYear()===now.getFullYear() && d.getMonth()===now.getMonth() && d.getDate()===now.getDate();
}
const EXPORT_SCOPE_LABELS = {
  all: 'all', created_today: 'created-today', movement_today: 'movement-today', date_range: 'date-range'
};
function openExportModal(){
  document.querySelector('input[name="exportScope"][value="all"]').checked = true;
  document.getElementById('exportDateFrom').value = '';
  document.getElementById('exportDateTo').value = '';
  document.getElementById('exportDateRangeRow').style.display = 'none';
  document.getElementById('exportErr').classList.remove('show');
  updateExportCount();
  document.getElementById('exportModal').classList.add('open');
}
function closeExportModal(){
  document.getElementById('exportModal').classList.remove('open');
}
function onExportScopeChange(){
  const scope = document.querySelector('input[name="exportScope"]:checked').value;
  document.getElementById('exportDateRangeRow').style.display = scope==='date_range' ? 'flex' : 'none';
  updateExportCount();
}
// Returns the matching leads, or null when a date-range scope is missing a
// bound — the caller distinguishes "0 matches" from "filter incomplete."
function getExportLeads(){
  const scope = document.querySelector('input[name="exportScope"]:checked').value;
  if(scope==='created_today') return leads.filter(l=>isToday(l.createdAt));
  if(scope==='movement_today') return leads.filter(l=>isToday(l.updatedAt));
  if(scope==='date_range'){
    const fromStr = document.getElementById('exportDateFrom').value;
    const toStr = document.getElementById('exportDateTo').value;
    if(!fromStr || !toStr) return null;
    const from = new Date(`${fromStr}T00:00:00`).getTime();
    const to = new Date(`${toStr}T23:59:59.999`).getTime();
    return leads.filter(l=>l.createdAt>=from && l.createdAt<=to);
  }
  return leads;
}
function updateExportCount(){
  const countEl = document.getElementById('exportCount');
  const result = getExportLeads();
  countEl.textContent = result===null ? 'Pick both a from and to date.' : `${result.length} lead${result.length===1?'':'s'} will be exported.`;
}
async function runExport(){
  if(typeof XLSX === 'undefined'){ showToast('Export library failed to load — check your connection and retry'); return; }
  const errBox = document.getElementById('exportErr');
  errBox.classList.remove('show');

  const scope = document.querySelector('input[name="exportScope"]:checked').value;
  if(scope==='date_range'){
    const fromStr = document.getElementById('exportDateFrom').value;
    const toStr = document.getElementById('exportDateTo').value;
    if(!fromStr || !toStr){ errBox.textContent='Pick both a from and to date.'; errBox.classList.add('show'); return; }
    if(fromStr > toStr){ errBox.textContent='"From" date must be before "To" date.'; errBox.classList.add('show'); return; }
  }

  const rows = getExportLeads();
  if(!rows || !rows.length){ errBox.textContent='No leads match this filter.'; errBox.classList.add('show'); return; }

  // Notes live in subcollections now — fetch each exported lead's notes (in
  // parallel) so the export still includes the full note history.
  showToast('Preparing export…');
  const notesByLead = new Map();
  await Promise.all(rows.map(async l => {
    const n = (l.notes && l.notes.length) ? l.notes : await window.crmFirebase.getLeadNotes(l.id);
    notesByLead.set(l.id, (n || []).slice().sort((a,b)=>(a.createdAt||0)-(b.createdAt||0)));
  }));

  const leadRows = rows.map(l=>{
    const stage = stageById(l.stageId);
    const notes = notesByLead.get(l.id) || [];
    const notesSummary = notes.map(n=>`[${new Date(n.createdAt).toLocaleString()}${n.by?' · '+n.by:''}] ${n.text}`).join('\n');
    return {
      'Name': l.name || '',
      'Phone': l.phone || '',
      'Email': l.email || '',
      'Channel': l.channel ? channelLabel(l.channel) : '',
      'Enquiry Type': l.enquiryType || '',
      'Property / Locality': l.propertyInterest || '',
      'Budget': l.budget || '',
      'Stage': stage ? stage.name : '',
      'Source': sourceLabel(l.source),
      'TailorTalk Status': isTtLead(l) ? ttStatusLabel(l.tt.status) : '',
      'TailorTalk Converted': isTtLead(l) ? (l.tt.converted ? 'Yes' : 'No') : '',
      'Last TailorTalk Message': isTtLead(l) && l.tt.lastMessageAt ? new Date(l.tt.lastMessageAt).toLocaleString() : '',
      'Sent Details': l.detailsSent === true ? 'Yes' : 'No',
      'Time of Contact': l.contactAt ? new Date(l.contactAt).toLocaleString() : '',
      'Follow-up': l.followUpAt ? new Date(l.followUpAt).toLocaleString() : '',
      'Added': l.createdAt ? new Date(l.createdAt).toLocaleString() : '',
      'Added By': l.createdBy || '',
      'Last Updated': l.updatedAt ? new Date(l.updatedAt).toLocaleString() : '',
      'Last Updated By': l.updatedBy || '',
      'Notes Count': notes.length,
      'Notes': notesSummary
    };
  });

  const wb = XLSX.utils.book_new();
  const leadsSheet = XLSX.utils.json_to_sheet(leadRows);
  leadsSheet['!cols'] = [
    {wch:20},{wch:14},{wch:22},{wch:14},{wch:16},{wch:24},{wch:12},{wch:14},
    {wch:16},{wch:14},{wch:12},{wch:19},
    {wch:12},{wch:19},{wch:19},{wch:19},{wch:22},{wch:19},{wch:22},{wch:10},{wch:50}
  ];
  XLSX.utils.book_append_sheet(wb, leadsSheet, 'Leads');

  const stamp = new Date().toISOString().slice(0,10);
  const label = EXPORT_SCOPE_LABELS[scope] || 'all';
  XLSX.writeFile(wb, `3pin-leads-export-${label}-${stamp}.xlsx`);
  closeExportModal();
  showToast('✓ Export downloaded');
}

// ═══════ DETAIL PANEL ═══════
function openDetail(id){
  const l = leads.find(x=>x.id===id);
  if(!l) return;
  currentDetailId = id;
  document.getElementById('dpName').textContent = l.name;
  const sub =
    l.source==='meta' ? 'Lead via Meta (Facebook/Instagram) Ads'
    : l.source==='tailortalk' ? `Lead via TailorTalk${l.tt && l.tt.leadSource ? ' · '+ttSourceLabel(l.tt.leadSource) : ''}`
    : isTtLead(l) ? 'Manually added lead · linked to a TailorTalk conversation'
    : 'Manually added lead';
  // A seller's lead carries its way over to the property card here, and back
  // again if that is where we came from — the two consoles are one workflow.
  document.getElementById('dpSub').innerHTML = escapeHtml(sub) + trackBackHtml(l);
  renderAiSummary(l);

  const waBtn = document.getElementById('dpWaBtn');
  const waUrl = waHref(l.phone);
  waBtn.style.display = waUrl ? '' : 'none';
  if(waUrl) waBtn.href = waUrl;
  // For a TailorTalk lead this opens the agent's OWN WhatsApp, not the business number the
  // lead has been chatting with — say so, because the message won't be in TailorTalk's chat.
  waBtn.innerHTML = isTtLead(l) ? '💬 WhatsApp<span class="dp-wa-mine"> from my phone</span>' : '💬 WhatsApp';
  waBtn.title = isTtLead(l) ? 'Opens WhatsApp on this device. It is not sent from the business number and will not appear in the TailorTalk chat.' : '';

  renderDetailStageRow(l);
  renderStandSection(l);
  renderFollowUpSpotlight(l);
  renderDetailInfo(l);
  // Scored from the lead document straight away, then again in
  // loadLeadThreads() once the notes arrive — the notes carry the objections,
  // which move the answer more than any stored field does.
  renderMatchingProperties(l);
  ttChatExpanded.delete(id);
  tlExpanded.delete(id);
  renderTtSection(l);
  if(isTtLead(l)){
    const cached = ttStateCache.get(l.id);
    if(!cached || cached.at !== l.tt.lastEventAt || cached.error) loadTtState(l);
  }

  const rawSec = document.getElementById('dpRawSec');
  if(l.source==='meta' && l.rawFieldData){
    rawSec.style.display='';
    document.getElementById('dpRaw').textContent = JSON.stringify(l.rawFieldData, null, 2);
  } else {
    rawSec.style.display='none';
  }

  renderNotes(l);
  renderNoteFollowUpFields(l);
  renderDetailsSentToggle(l);
  renderHistory(l);
  document.getElementById('dp').classList.add('open');
  // The lead pane scrolls, not #dp — and resetting the page scroll here used to
  // throw away the caller's place in a long list, which closeDetail() then
  // returned them to the top of.
  const dpb = document.querySelector('#dp .dp-body');
  if(dpb) dpb.scrollTop = 0;
  // A sheet is per-viewing: opening the next lead should not inherit the last
  // one's open conversation on a narrow screen.
  convSheetOpen = false;
  initDpResizer();
  syncConversationPane();
  // Live for as long as this lead is on screen.
  watchTtState(l);
  // Notes + history live in subcollections — load them on open (the board
  // never needs them). Renders again once they arrive.
  loadLeadThreads(l);
}

// Lead Info block — its own function so a TailorTalk update can refresh it on an open lead.
function renderDetailInfo(l){
  const infoHtml = `
    ${l.channel?`<div class="info-b"><div class="info-b-l">Channel</div><div class="info-b-v">${channelLabel(l.channel)}</div></div>`:''}
    ${l.phone?`<div class="info-b"><div class="info-b-l">Phone</div><div class="info-b-v"><a href="tel:${encodeURIComponent(l.phone)}">${escapeHtml(l.phone)}</a></div></div>`:''}
    ${l.email?`<div class="info-b"><div class="info-b-l">Email</div><div class="info-b-v"><a href="mailto:${encodeURIComponent(l.email)}">${escapeHtml(l.email)}</a></div></div>`:''}
    ${!l.phone && isTtLead(l) && l.tt.handle?`<div class="info-b"><div class="info-b-l">Instagram</div><div class="info-b-v"><a href="https://instagram.com/${encodeURIComponent(l.tt.handle)}" target="_blank" rel="noopener">@${escapeHtml(l.tt.handle)}</a></div></div>`:''}
    ${l.enquiryType?`<div class="info-b"><div class="info-b-l">Enquiry Type</div><div class="info-b-v">${escapeHtml(l.enquiryType)}</div></div>`:''}
    ${l.propertyInterest?`<div class="info-b highlight"><div class="info-b-l">Property / Locality</div><div class="info-b-v">${escapeHtml(l.propertyInterest)}</div></div>`:''}
    ${l.budget?`<div class="info-b highlight"><div class="info-b-l">Budget</div><div class="info-b-v">${escapeHtml(l.budget)}</div></div>`:''}
    ${l.formId?`<div class="info-b"><div class="info-b-l">Meta Form ID</div><div class="info-b-v">${escapeHtml(l.formId)}</div></div>`:''}
    ${l.adId?`<div class="info-b"><div class="info-b-l">Meta Ad ID</div><div class="info-b-v">${escapeHtml(l.adId)}</div></div>`:''}
    <div class="info-b pl-row" id="dpPropLinks">${propertyLinksInner(l)}</div>
    ${isSellerLead(l) ? `<div class="info-b pl-row"><div class="info-b-l">Listing</div><div class="info-b-v pl-chips">
      <span class="pl-chip"><a href="propertytrack.html?nav=sellers" title="Track this property's details, shoot and brochure on the Property &amp; Media board">🏷️ Track this listing →</a></span>
    </div></div>` : ''}
  `;
  // A snapshot redraw must not throw away a property search being typed.
  const plFocused = document.activeElement && document.activeElement.id === 'plInput';
  document.getElementById('dpInfo').innerHTML = infoHtml;
  if(plFocused){ const i = document.getElementById('plInput'); if(i){ i.focus(); i.setSelectionRange(i.value.length, i.value.length); } }
  if((l.propertyCodes || []).length && !inventory) loadInventory().then(() => { if(currentDetailId === l.id) renderPropertyLinks(l.id); });

  const metaHtml = `
    <div class="dp-meta-item"><span class="dp-meta-l">Contacted</span><span class="dp-meta-v">${new Date(l.contactAt||l.createdAt).toLocaleString([], { month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' })}</span></div>
    <div class="dp-meta-item"><span class="dp-meta-l">Added</span><span class="dp-meta-v">${new Date(l.createdAt).toLocaleString([], { month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' })}</span></div>
    ${l.createdBy?`<div class="dp-meta-item"><span class="dp-meta-l">By</span><span class="dp-meta-v">${escapeHtml(l.createdBy.split('@')[0])}</span></div>`:''}
    ${l.updatedBy?`<div class="dp-meta-item"><span class="dp-meta-l">Updated by</span><span class="dp-meta-v">${escapeHtml(l.updatedBy.split('@')[0])}</span></div>`:''}
  `;
  document.getElementById('dpMeta').innerHTML = metaHtml;
}

// ═══════ PROPERTY LINKS (lead ↔ inventory, crm-assets/propertyLinks.js) ═══════
// lead.propertyCodes are inventory ids. Automation links codes a lead already talks about; a
// person links more from here, or unlinks one — which automation then never re-adds.
let inventory = null;
let inventoryLoading = null;
let propLinkOpenFor = null;
let propLinkQuery = '';
function loadInventory(){
  if(inventory) return Promise.resolve(inventory);
  if(!inventoryLoading){
    inventoryLoading = Promise.resolve(window.crmFirebase && window.crmFirebase.getInventory ? window.crmFirebase.getInventory() : [])
      .then(list => { inventory = Array.isArray(list) ? list : []; return inventory; })
      .catch(() => { inventoryLoading = null; return []; });
  }
  return inventoryLoading;
}
const inventoryById = id => (inventory || []).find(p => p.id === id) || null;
// "ANR003" for coded rows; older inventory rows only have a number as their id, so they go by name.
const propertyCodeOf = p => p && p.propertyCode && !/^\d+$/.test(p.propertyCode) ? p.propertyCode : '';
function propertyShortLabel(id){
  const p = inventoryById(id);
  if(!p) return /^\d+$/.test(id) ? `Property ${id}` : id;
  return [propertyCodeOf(p), p.name].filter(Boolean).join(' · ') || id;
}
function propertyLinksInner(l){
  const ids = l.propertyCodes || [];
  const chips = ids.map(id => {
    const p = inventoryById(id);
    const code = p ? propertyCodeOf(p) : (/^\d+$/.test(id) ? '' : id);
    const title = p ? [p.name, p.location, p.config, p.startingPrice].filter(Boolean).join(' · ') : id;
    return `<span class="pl-chip${p && p.soldOut ? ' sold' : ''}"><a href="property.html?id=${encodeURIComponent(id)}" target="_blank" rel="noopener" title="${escapeHtml(title)}">${code ? `<b>${escapeHtml(code)}</b>` : ''}${p && p.name ? `<span>${escapeHtml(p.name)}</span>` : (code ? '' : escapeHtml(propertyShortLabel(id)))}${p && p.soldOut ? '<i>sold</i>' : ''}</a><button type="button" aria-label="Unlink ${escapeHtml(propertyShortLabel(id))}" title="Unlink" onclick="unlinkProperty('${l.id}','${escapeHtml(id)}')">×</button></span>`;
  }).join('');
  const open = propLinkOpenFor === l.id;
  return `<div class="info-b-l">Properties</div>
    <div class="info-b-v">
      <div class="pl-chips">${chips || '<span class="pl-none">None linked</span>'}${open ? '' : `<button type="button" class="pl-add" onclick="openPropertyLink('${l.id}')">＋ Link</button>`}</div>
      ${open ? `<div class="pl-pick">
        <div class="pl-pick-row"><input id="plInput" autocomplete="off" placeholder="Search code, name or area…" value="${escapeHtml(propLinkQuery)}" oninput="propLinkQuery=this.value; renderPropertyResults('${l.id}')" onkeydown="if(event.key==='Escape')closePropertyLink()"><button type="button" class="pl-cancel" onclick="closePropertyLink()">Done</button></div>
        <div class="pl-results" id="plResults">${propertyResultsHtml(l)}</div>
      </div>` : ''}
    </div>`;
}
function propertyResultsHtml(l){
  if(!inventory) return '<div class="pl-empty">Loading inventory…</div>';
  const ids = new Set(l.propertyCodes || []);
  const q = propLinkQuery.trim().toLowerCase();
  const matches = inventory.filter(p => !ids.has(p.id) && (!q || [p.id, p.propertyCode, p.name, p.location, p.config].join(' ').toLowerCase().includes(q))).slice(0, 8);
  if(!matches.length) return '<div class="pl-empty">No matching property</div>';
  return matches.map(p => `<button type="button" onclick="linkProperty('${l.id}','${escapeHtml(p.id)}')">${propertyCodeOf(p) ? `<b>${escapeHtml(propertyCodeOf(p))}</b> ` : ''}${escapeHtml(p.name || p.id)}<small>${escapeHtml([p.location, p.config, p.startingPrice, p.soldOut ? 'sold' : ''].filter(Boolean).join(' · '))}</small></button>`).join('');
}
function renderPropertyLinks(leadId){
  const el = document.getElementById('dpPropLinks');
  const l = leads.find(x => x.id === leadId);
  if(!el || !l) return;
  el.innerHTML = propertyLinksInner(l);
}
function renderPropertyResults(leadId){
  const el = document.getElementById('plResults');
  const l = leads.find(x => x.id === leadId);
  if(el && l) el.innerHTML = propertyResultsHtml(l);
}
function openPropertyLink(leadId){
  propLinkOpenFor = leadId; propLinkQuery = '';
  renderPropertyLinks(leadId);
  const inp = document.getElementById('plInput'); if(inp) inp.focus();
  loadInventory().then(() => { if(propLinkOpenFor === leadId) renderPropertyResults(leadId); });
}
function closePropertyLink(){
  const id = propLinkOpenFor;
  propLinkOpenFor = null; propLinkQuery = '';
  if(id) renderPropertyLinks(id);
}
function linkProperty(leadId, propertyId){
  const l = leads.find(x => x.id === leadId);
  if(!l || (l.propertyCodes || []).includes(propertyId)) return;
  const now = Date.now();
  l.propertyCodes = [...(l.propertyCodes || []), propertyId];
  l.unlinkedPropertyIds = (l.unlinkedPropertyIds || []).filter(x => x !== propertyId);
  addHistory(l, 'field', `Linked to property <b>${escapeHtml(propertyShortLabel(propertyId))}</b>`);
  l.updatedAt = now; l.updatedBy = currentUserEmail || l.updatedBy || null; l.lastActionType = 'field';
  persistLead(l);
  propLinkQuery = '';
  renderPropertyLinks(leadId);
  const inp = document.getElementById('plInput'); if(inp) inp.focus();
  if(currentDetailId === leadId) renderHistory(l);
}
function unlinkProperty(leadId, propertyId){
  const l = leads.find(x => x.id === leadId);
  if(!l) return;
  const now = Date.now();
  l.propertyCodes = (l.propertyCodes || []).filter(x => x !== propertyId);
  if(!(l.unlinkedPropertyIds || []).includes(propertyId)) l.unlinkedPropertyIds = [...(l.unlinkedPropertyIds || []), propertyId];
  addHistory(l, 'field', `Unlinked property <b>${escapeHtml(propertyShortLabel(propertyId))}</b>`);
  l.updatedAt = now; l.updatedBy = currentUserEmail || l.updatedBy || null; l.lastActionType = 'field';
  persistLead(l);
  renderPropertyLinks(leadId);
  if(currentDetailId === leadId) renderHistory(l);
}
// crm.html?propertyId=ANR003 (from Property Intelligence and property pages): only the leads
// linked to that property, until the chip is cleared.
let propertyFilter = null;
try{ propertyFilter = new URLSearchParams(location.search).get('propertyId') || null; }catch(e){}
function clearPropertyFilter(){
  propertyFilter = null;
  try{ const u = new URL(location.href); u.searchParams.delete('propertyId'); history.replaceState(null, '', u.pathname + u.search + u.hash); }catch(e){}
  renderLeadFilterBar();
  applyFilters();
}

// ── crm.html?lead=<id> — open one lead straight away ──
// Arriving from the Property & Media board (&from=track&listing=<id>) also
// shows a way back to the exact card you came from, because a link that
// strands you somewhere is worse than no link. The lead may not have arrived
// from Firestore yet, so this retries until the snapshot lands.
let pendingLeadOpen = null, pendingLeadTries = 0;
let cameFromTrack = null;   // { listingId } when we arrived from the board
try{
  const q = new URLSearchParams(location.search);
  pendingLeadOpen = q.get('lead') || null;
  if(q.get('from') === 'track') cameFromTrack = { listingId: q.get('listing') || null };
}catch(e){}
function openPendingLead(){
  if(!pendingLeadOpen) return;
  if(leads.some(l => l.id === pendingLeadOpen)){
    const id = pendingLeadOpen; pendingLeadOpen = null;
    openDetail(id);
    // Keep ?lead= out of the URL once used, so a refresh does not fight the
    // user's own navigation — same rule AppNav.takeNav() follows.
    try{ const u = new URL(location.href); u.searchParams.delete('lead'); history.replaceState(null, '', u.pathname + u.search + u.hash); }catch(e){}
  } else if(++pendingLeadTries > 40){
    pendingLeadOpen = null;
    showToast('That lead could not be found');
  }
}
// The way back to the board, rendered into the lead panel's header.
function trackBackHtml(l){
  const listingId = (cameFromTrack && cameFromTrack.listingId) || l.listingId || null;
  if(!listingId && !isSellerLead(l)) return '';
  const href = listingId
    ? 'propertytrack.html?listing=' + encodeURIComponent(listingId)
    : 'propertytrack.html?nav=sellers';
  const label = cameFromTrack ? '← Back to the property card'
    : (listingId ? '🏷️ Open its property card' : '🏷️ Track this listing');
  return `<a class="dp-track-link" href="${href}" title="Property &amp; Media Track">${label}</a>`;
}

// Fetch a lead's notes + history subcollections into the in-memory object and
// re-render the panels. Merges with anything already on the object (e.g. a
// parent still carrying pre-migration arrays) and de-dupes by id, so nothing
// is ever dropped during the cutover window.
async function loadLeadThreads(l){
  try{
    const [notes, history] = await Promise.all([
      window.crmFirebase.getLeadNotes(l.id),
      window.crmFirebase.getLeadHistory(l.id)
    ]);
    const byId = (arr) => { const m = new Map(); (arr||[]).forEach(x => { if(x && x.id) m.set(x.id, x); }); return m; };
    const notesMap = byId(l.notes); byId(notes).forEach((v,k)=>notesMap.set(k,v));
    const histMap = byId(l.history); byId(history).forEach((v,k)=>histMap.set(k,v));
    l.notes = Array.from(notesMap.values()).sort((a,b)=>(a.createdAt||0)-(b.createdAt||0));
    l.history = Array.from(histMap.values()).sort((a,b)=>(a.at||0)-(b.at||0));
    recomputeNoteMeta(l);
    if(currentDetailId === l.id && document.getElementById('dp').classList.contains('open')){
      renderNotes(l);
      renderHistory(l);
      renderFollowUpSpotlight(l);
      if(isTtLead(l)) renderTtSection(l);
      // The notes have only just arrived, and they are where the objections
      // live — "said the price is high", "too far from his office". Those
      // change the matching more than any field on the lead does, so the
      // match list is scored again now that they are here.
      renderMatchingProperties(l);
    }
  } catch(e){
    console.error('loadLeadThreads failed:', e);
  }
}

// ═══════ MATCHING PROPERTIES ═══════
//
// "What do we show them?" — the reverse of the Properties console's Matching
// Buyers tab, and deliberately the same engine and the same panel, so the two
// screens can never disagree about a pair.
//
// Sellers and vendors are skipped: this section answers a BUYER's question.
// A seller's own listing work belongs on the Property & Media board, which is
// where the Lead Info block already points them.
function renderMatchingProperties(l){
  const sec = document.getElementById('dpMatchSec');
  const el = document.getElementById('dpMatch');
  if(!sec || !el || !window.PinMatch || !window.PinMatchPanel) return;

  if(!window.PinMatch.isBuyerLead(l) || isSellerLead(l)){ sec.hidden = true; return; }
  sec.hidden = false;
  PinMatchPanel.busy(el, 'Scoring the inventory against this requirement…');

  loadInventory().then(list => {
    if(currentDetailId !== l.id) return;       // moved on while the read was in flight
    if(!list.length){
      el.classList.add('pm');
      el.innerHTML = '<div class="pm-empty">The inventory has not loaded yet.</div>';
      return;
    }
    const req = PinMatch.requirementProfile(l, { inventory: list, notes: l.notes });
    // Nothing to go on. Say which field would unlock it rather than showing
    // an empty list — the fix is thirty seconds of typing, and this is the
    // one moment the person who can do it is looking at the record.
    if(!req.budget && !req.localities && !req.bhk && !req.types){
      el.classList.add('pm');
      el.innerHTML = '<div class="pm-empty">Nothing to match on yet. Fill in <b>Property / Locality</b> or <b>Budget</b> above'
        + ' — an area, a budget or "3BHK" is enough to rank the whole inventory against this buyer.</div>';
      return;
    }
    const matches = PinMatch.propertiesFor(req, list, {
      includeVetoed: true, includeSeen: true, minPct: 40, limit: 40
    });
    const live = matches.filter(m => !m.vetoed).length;
    PinMatchPanel.render(el, matches, {
      title: live === 1 ? '1 property worth sending' : `${live} properties worth sending`,
      subtitle: `out of ${list.length} in the inventory`,
      empty: 'Nothing in the inventory fits this requirement yet. The ruled-out list below says why for each one'
        + ' — which is also the brief to go sourcing against.',
      shape: m => ({
        code: m.property.code || '',
        name: m.p.name || m.p.id,
        sub: [
          m.p.location, m.p.config,
          m.property.priceLo != null ? PinMatch.fmtMoney(m.property.priceLo) : m.p.startingPrice,
          m.alreadyShared ? '· already shared with them' : ''
        ].filter(Boolean).join(' · '),
        actions: [
          { id:'open', key:m.p.id, label:'Open property →', href:'property.html?id=' + encodeURIComponent(m.p.id), blank:true, primary:true },
          m.alreadyShared ? null : { id:'link', key:m.p.id, label:'Link to this lead' }
        ].filter(Boolean)
      }),
      onAction: (act, key) => {
        // Reuses the existing link path, so a property linked from here is
        // indistinguishable from one linked by hand — same history entry,
        // same automation rules.
        if(act === 'link' && typeof linkProperty === 'function') linkProperty(l.id, key);
      }
    });
  });
}
function renderDetailStageRow(l){
  const sel = document.getElementById('dpStageSel');
  sel.innerHTML = stages.map(s=>`<option value="${s.id}" ${s.id===l.stageId?'selected':''}>${escapeHtml(s.name)}</option>`).join('');
  const stage = stageById(l.stageId);
  sel.style.borderColor = stage ? stage.color : '';
  sel.style.color = stage ? stage.color : '';
}
// Leads with no `detailsSent` field yet (everything created before this
// feature) read as "No" by default — same as an explicit false — so there's
// no migration needed and nothing forces an agent to set it.
function renderDetailsSentToggle(l){
  const wrap = document.getElementById('dpDetailsSentToggle');
  if(!wrap) return;
  const effective = l.detailsSent === true;
  wrap.querySelector('.yes').classList.toggle('active', effective);
  wrap.querySelector('.no').classList.toggle('active', !effective);
  // Colour alone told a screen-reader user nothing about which one is chosen.
  wrap.querySelector('.yes').setAttribute('aria-pressed', effective ? 'true' : 'false');
  wrap.querySelector('.no').setAttribute('aria-pressed', effective ? 'false' : 'true');
  wrap.classList.toggle('sent', effective);
  wrap.classList.toggle('not-sent', !effective);
}
function setDetailsSent(value){
  const l = leads.find(x=>x.id===currentDetailId);
  if(!l) return;
  const prevEffective = l.detailsSent === true;
  if(prevEffective === value) return;
  const label = v => v ? 'Yes' : 'No';
  addHistory(l, 'details-sent', `Sent details changed from <b>${label(prevEffective)}</b> to <b>${label(value)}</b>`);
  l.detailsSent = value;
  l.updatedAt = Date.now();
  l.updatedBy = currentUserEmail || l.updatedBy || null;
  l.lastActionType = 'details-sent';
  renderDetailsSentToggle(l);
  renderHistory(l);
  persistLead(l);
}
function onDetailStageChange(){
  const sel = document.getElementById('dpStageSel');
  changeStage(currentDetailId, sel.value);
}
function closeDetail(){
  document.getElementById('dp').classList.remove('open');
  currentDetailId = null;
  convSheetOpen = false;
  stopTtWatch();
  const split = document.getElementById('dpSplit');
  if(split) split.classList.remove('split', 'sheet');
}
function toggleRaw(){
  const shown = document.getElementById('dpRaw').classList.toggle('show');
  const btn = document.querySelector('.raw-toggle');
  if(btn) btn.setAttribute('aria-expanded', shown ? 'true' : 'false');
}

// ═══════ NOTES ═══════
function renderNotes(l){ renderTimeline(l); }
function renderNoteFollowUpFields(l){
  const fu = l.followUpAt ? new Date(l.followUpAt) : null;
  document.getElementById('noteFollowUpDate').value = fu ? toDateInputValue(fu) : '';
  document.getElementById('noteFollowUpTime').value = fu ? toTimeInputValue(fu) : '';
  const actions = document.getElementById('noteFuActions');
  if(actions) actions.style.display = l.followUpAt ? 'flex' : 'none';
}
function parseFollowUpRaw(dateStr, timeStr){
  if(!dateStr) return null;
  return timeStr ? new Date(`${dateStr}T${timeStr}:00`).getTime() : new Date(`${dateStr}T00:00:00`).getTime();
}
// Closes out a follow-up: log what happened AND set the next one in one
// step — a real estate agent almost always needs both ("called, still
// deciding on budget — check back in a week"), so this never silently
// wipes the date the way a bare "mark done" would. removeFollowUp() below
// stays fully separate for when a lead genuinely needs no more follow-up.
let fuLogLeadId = null;
function openFollowUpLogModal(leadId){
  const l = leads.find(x=>x.id===leadId);
  if(!l) return;
  fuLogLeadId = leadId;
  document.getElementById('fuLogLeadName').textContent = l.name;
  document.getElementById('fuLogNote').value = '';
  document.getElementById('fuLogDate').value = '';
  document.getElementById('fuLogTime').value = '';
  document.getElementById('fuLogErr').classList.remove('show');
  document.getElementById('fuLogModal').classList.add('open');
  document.getElementById('fuLogNote').focus();
}
function closeFollowUpLogModal(){
  document.getElementById('fuLogModal').classList.remove('open');
  fuLogLeadId = null;
}
// Real-estate follow-up cadence — tomorrow/3-day/week/fortnight covers the
// common "still deciding," "post-site-visit," and "nurture" cases without
// making the agent operate a date picker for every single lead.
function setFuLogPreset(days){
  const dateInp = document.getElementById('fuLogDate');
  const timeInp = document.getElementById('fuLogTime');
  if(days===null){ dateInp.value=''; timeInp.value=''; return; }
  const d = new Date();
  d.setDate(d.getDate()+days);
  dateInp.value = toDateInputValue(d);
}
function saveFollowUpLog(){
  const l = leads.find(x=>x.id===fuLogLeadId);
  if(!l) return;
  const errBox = document.getElementById('fuLogErr');
  errBox.classList.remove('show');

  const noteText = document.getElementById('fuLogNote').value.trim();
  const dateStr = document.getElementById('fuLogDate').value;
  const timeStr = document.getElementById('fuLogTime').value;

  let followUpAt = null;
  if(dateStr){
    const r = computeFollowUpAt(dateStr, timeStr);
    if(r.error){ errBox.textContent = r.error; errBox.classList.add('show'); return; }
    followUpAt = r.value;
  }

  const now = Date.now();
  const prevFollowUpAt = l.followUpAt;
  const dateChanged = (prevFollowUpAt||null) !== (followUpAt||null);
  // The note carries what was said, so the event line must not repeat it — it
  // says what was DONE, and where that leaves the lead. One line, not three.
  const nextBit = !dateChanged ? ''
    : followUpAt
      ? ` · next <b>${new Date(followUpAt).toLocaleString([], { month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' })}</b>`
      : ' · no follow-up from here';
  if(noteText) logNote(l, { id:'n'+now, text: noteText, createdAt: now, by: currentUserEmail || null });
  addHistory(l, dateChanged && !followUpAt ? 'followup-removed' : 'followed-up',
    `Followed up${nextBit}`);
  l.followUpAt = followUpAt;
  l.followUpBy = currentUserEmail || 'team'; l.followUpSetAt = now; l.followUpNote = null;
  l.updatedAt = now;
  l.updatedBy = currentUserEmail || l.updatedBy || null;
  l.lastActionType = 'followed-up';
  persistLead(l);
  closeFollowUpLogModal();
  refreshAll();
  showToast(followUpAt ? '✓ Logged — next follow-up set' : '✓ Logged — no further follow-up');
  if(currentDetailId===l.id){ renderNotes(l); renderNoteFollowUpFields(l); renderFollowUpSpotlight(l); renderHistory(l); }
}
function removeFollowUp(leadId){
  const l = leads.find(x=>x.id===leadId);
  if(!l) return;
  if(!confirm(`Remove the follow-up for "${l.name}"?`)) return;
  if(l.followUpAt) addHistory(l, 'followup-removed', 'Follow-up removed');
  l.followUpAt = null;
  l.followUpBy = currentUserEmail || 'team'; l.followUpSetAt = Date.now(); l.followUpNote = null;
  l.updatedAt = Date.now();
  l.updatedBy = currentUserEmail || l.updatedBy || null;
  l.lastActionType = 'followup-removed';
  persistLead(l);
  refreshAll();
  showToast('Follow-up removed');
  if(currentDetailId===leadId){ renderNoteFollowUpFields(l); renderFollowUpSpotlight(l); renderHistory(l); }
}
function addNote(){
  const inp = document.getElementById('noteInput');
  const text = inp.value.trim();
  if(!text) return;
  const l = leads.find(x=>x.id===currentDetailId);
  if(!l) return;

  const fuDateStr = document.getElementById('noteFollowUpDate').value;
  const fuTimeStr = document.getElementById('noteFollowUpTime').value;
  const currentAt = l.followUpAt || null;
  const candidateAt = parseFollowUpRaw(fuDateStr, fuTimeStr);
  let nextFollowUpAt = currentAt;
  // Only re-validate "must be future" when the agent actually changed the
  // date/time — leaving it as-is must never block saving a note, even if
  // that existing follow-up has since gone overdue.
  if(candidateAt !== currentAt){
    if(candidateAt === null){
      nextFollowUpAt = null;
    } else {
      const r = computeFollowUpAt(fuDateStr, fuTimeStr);
      if(r.error){ showToast(r.error); return; }
      nextFollowUpAt = r.value;
    }
  }

  const now = Date.now();
  const M = window.crmMentions;
  const mentioned = M ? M.mentionedEmails(text, teamRoster(), currentUserEmail) : [];
  const note = { id:'n'+now, text, createdAt: now, by: currentUserEmail || null };
  if(mentioned.length) note.mentions = mentioned;
  logNote(l, note);
  if(mentioned.length){
    // The latest mention of each person, on the lead itself — what their filter, card and digest read.
    l.mentions = { ...(l.mentions || {}) };
    mentioned.forEach(email => { l.mentions[M.teamKey(email)] = { email, by: currentUserEmail || null, at: now, noteId: note.id, text: text.slice(0, 160), doneAt: null }; });
    showToast(`✓ Note added — ${mentioned.map(M.displayName).join(', ')} will see it`);
  }
  hideMentionMenu();
  if(nextFollowUpAt !== currentAt){
    if(nextFollowUpAt){
      const when = new Date(nextFollowUpAt).toLocaleString([], { month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' });
      addHistory(l, 'followup', `Next follow-up ${currentAt?'changed to':'set for'} <b>${when}</b>`);
    } else {
      addHistory(l, 'followup-removed', 'Follow-up removed');
    }
  }
  if(nextFollowUpAt !== currentAt){ l.followUpBy = currentUserEmail || 'team'; l.followUpSetAt = now; l.followUpNote = null; }
  l.followUpAt = nextFollowUpAt;
  l.updatedAt = now;
  l.updatedBy = currentUserEmail || l.updatedBy || null;
  l.lastActionType = 'note';
  inp.value='';
  renderNotes(l);
  renderNoteFollowUpFields(l);
  renderFollowUpSpotlight(l);
  renderHistory(l);
  applyFilters();
  persistLead(l);
}
// ═══════ @MENTIONS (crm-assets/mentions.js) ═══════
// The team is the list in settings/{tenant}.team — set by the owner, never guessed from lead data
// and never added to on login.
let team = {};
window.applyTeamSnapshot = function(map){
  team = map && typeof map === 'object' ? map : {};
};
function teamRoster(){
  const set = new Set();
  Object.values(team).forEach(m => { const e = m && m.email; if(e && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(e))) set.add(String(e).trim().toLowerCase()); });
  return [...set].sort();
}
function myOpenMention(l){ return window.crmMentions && currentUserEmail ? window.crmMentions.openMentionFor(l, currentUserEmail) : null; }
function markMentionDone(leadId){
  const l = leads.find(x => x.id === leadId);
  const M = window.crmMentions;
  if(!l || !M || !currentUserEmail) return;
  const key = M.teamKey(currentUserEmail);
  if(!l.mentions || !l.mentions[key]) return;
  l.mentions = { ...l.mentions, [key]: { ...l.mentions[key], doneAt: Date.now() } };
  persistLead(l);
  refreshAll();
  if(currentDetailId === leadId) renderStandSection(l);
  showToast('✓ Done');
}
// A note's @handles, highlighted when they are someone on the team.
function mentionifyHtml(escapedText){
  const M = window.crmMentions;
  if(!M) return escapedText;
  const handles = new Map(teamRoster().map(e => [M.handleOf(e), e]));
  return escapedText.replace(/(^|[^\w@])@([a-z0-9](?:[a-z0-9._-]*[a-z0-9])?)/gi, (all, pre, h) => {
    const email = handles.get(h.toLowerCase());
    return email ? `${pre}<span class="mention" title="${escapeHtml(email)}">@${escapeHtml(M.displayName(email))}</span>` : all;
  });
}
// New mentions of me while the CRM is open → one toast.
const mentionsSeen = new Set();
let mentionsPrimed = false;
function notifyNewMentions(){
  if(!currentUserEmail || !window.crmMentions) return;
  const mine = leads.map(l => ({ l, m: myOpenMention(l) })).filter(x => x.m);
  const fresh = mine.filter(x => !mentionsSeen.has(`${x.l.id}:${x.m.at}`));
  fresh.forEach(x => mentionsSeen.add(`${x.l.id}:${x.m.at}`));
  if(!mentionsPrimed){ mentionsPrimed = true; return; }  // what was already open at load is on the filter chip
  if(fresh.length === 1) showToast(`@ ${window.crmMentions.displayName(fresh[0].m.by || '')} mentioned you on ${fresh[0].l.name}`);
  else if(fresh.length > 1) showToast(`@ You were mentioned on ${fresh.length} leads`);
}

// The @ picker under the note box.
let mentionState = null;
function setupMentions(){
  const inp = document.getElementById('noteInput');
  if(!inp || inp.dataset.mentions) return;
  inp.dataset.mentions = '1';
  inp.addEventListener('input', updateMentionMenu);
  inp.addEventListener('click', updateMentionMenu);
  inp.addEventListener('keydown', mentionKeydown);
  inp.addEventListener('blur', () => setTimeout(hideMentionMenu, 150));
}
function mentionMenuOpen(){ return !!mentionState; }
function updateMentionMenu(){
  const inp = document.getElementById('noteInput');
  const M = window.crmMentions;
  if(!inp || !M){ hideMentionMenu(); return; }
  const caret = inp.selectionStart == null ? inp.value.length : inp.selectionStart;
  const m = /(^|[^\w@])@([a-z0-9._-]*)$/i.exec(inp.value.slice(0, caret));
  if(!m){ hideMentionMenu(); return; }
  const q = m[2].toLowerCase();
  const me = String(currentUserEmail || '').toLowerCase();
  const items = teamRoster().filter(e => e !== me && (M.handleOf(e).startsWith(q) || M.displayName(e).toLowerCase().includes(q))).slice(0, 6);
  if(!items.length){ hideMentionMenu(); return; }
  const keep = mentionState && mentionState.items[mentionState.index];
  mentionState = { start: caret - m[2].length - 1, end: caret, items, index: Math.max(0, items.indexOf(keep)) };
  renderMentionMenu();
}
function renderMentionMenu(){
  const menu = document.getElementById('mentionMenu');
  const M = window.crmMentions;
  if(!menu || !mentionState || !M) return;
  menu.hidden = false;
  menu.innerHTML = mentionState.items.map((e, i) => `<button type="button" role="option" aria-selected="${i === mentionState.index}" class="${i === mentionState.index ? 'at' : ''}" onmousedown="event.preventDefault();pickMention(${i})"><b>${escapeHtml(M.displayName(e))}</b><small>@${escapeHtml(M.handleOf(e))}</small></button>`).join('');
}
function hideMentionMenu(){
  mentionState = null;
  const menu = document.getElementById('mentionMenu');
  if(menu){ menu.hidden = true; menu.innerHTML = ''; }
}
function mentionKeydown(e){
  if(!mentionState) return;
  const n = mentionState.items.length;
  if(e.key === 'ArrowDown'){ e.preventDefault(); mentionState.index = (mentionState.index + 1) % n; renderMentionMenu(); }
  else if(e.key === 'ArrowUp'){ e.preventDefault(); mentionState.index = (mentionState.index - 1 + n) % n; renderMentionMenu(); }
  else if(e.key === 'Enter' || e.key === 'Tab'){ e.preventDefault(); pickMention(mentionState.index); }
  else if(e.key === 'Escape'){ e.preventDefault(); hideMentionMenu(); }
}
function pickMention(i){
  const inp = document.getElementById('noteInput');
  const M = window.crmMentions;
  if(!inp || !mentionState || !M) return;
  const email = mentionState.items[i];
  const token = '@' + M.handleOf(email) + ' ';
  const { start, end } = mentionState;
  inp.value = inp.value.slice(0, start) + token + inp.value.slice(end);
  const caret = start + token.length;
  hideMentionMenu();
  inp.focus();
  inp.setSelectionRange(caret, caret);
}

function deleteNote(leadId, noteId){
  const l = leads.find(x=>x.id===leadId);
  if(!l) return;
  l.notes = (l.notes||[]).filter(n=>n.id!==noteId);
  recomputeNoteMeta(l);
  l.updatedAt = Date.now();
  l.updatedBy = currentUserEmail || l.updatedBy || null;
  renderNotes(l);
  if(window.crmFirebase.deleteNoteDoc) window.crmFirebase.deleteNoteDoc(leadId, noteId);
  persistLead(l);
}

// ═══════ STAGE MANAGER ═══════
const STAGE_COLORS = ['#1D4ED8','#B45309','#6D28D9','#15803D','#B91C1C','#0891B2','#DB2777'];
function openStageManager(){
  stageManagerDraft = stages.map(s=>({...s}));
  renderStageManagerRows();
  document.getElementById('stageModal').classList.add('open');
}
function closeStageManager(){
  document.getElementById('stageModal').classList.remove('open');
}
function renderStageManagerRows(){
  document.getElementById('stageRows').innerHTML = stageManagerDraft.map((s,i)=>`
    <div class="stage-row">
      <button class="stage-move" aria-label="Move ${escapeHtml(s.name)} up" onclick="moveStageDraft(${i},-1)" ${i===0?'disabled':''}>↑</button>
      <button class="stage-move" aria-label="Move ${escapeHtml(s.name)} down" onclick="moveStageDraft(${i},1)" ${i===stageManagerDraft.length-1?'disabled':''}>↓</button>
      <button type="button" class="stage-color" style="background:${s.color}" aria-label="Change colour of ${escapeHtml(s.name)}" onclick="cycleStageColor(${i})"></button>
      <input type="text" aria-label="Stage name" value="${escapeHtml(s.name)}" oninput="renameStageDraft(${i}, this.value)">
      <button class="stage-del" aria-label="Delete stage ${escapeHtml(s.name)}" onclick="deleteStageDraft(${i})">🗑️</button>
    </div>`).join('');
}
function renameStageDraft(i, val){ stageManagerDraft[i].name = val; }
function cycleStageColor(i){
  const cur = STAGE_COLORS.indexOf(stageManagerDraft[i].color);
  stageManagerDraft[i].color = STAGE_COLORS[(cur+1)%STAGE_COLORS.length];
  renderStageManagerRows();
}
function moveStageDraft(i, dir){
  const j = i+dir;
  if(j<0 || j>=stageManagerDraft.length) return;
  [stageManagerDraft[i], stageManagerDraft[j]] = [stageManagerDraft[j], stageManagerDraft[i]];
  renderStageManagerRows();
}
function deleteStageDraft(i){
  if(stageManagerDraft.length<=1){ showToast('Keep at least one stage'); return; }
  const keyed = stageManagerDraft[i].key;
  const warn = keyed ? `\n\nThis column is part of the lead pipeline ("${stageManagerDraft[i].key}"). Lead automation, the dashboard and the daily digest rely on it — without it, automation stops moving leads.` : '';
  if(!confirm(`Delete stage "${stageManagerDraft[i].name}"? Leads in it will move to the first stage.${warn}`)) return;
  stageManagerDraft.splice(i,1);
  renderStageManagerRows();
}
function addStageDraft(){
  const inp = document.getElementById('newStageName');
  const name = inp.value.trim();
  if(!name) return;
  stageManagerDraft.push({ id:'stage_'+Date.now()+Math.random().toString(36).slice(2,6), name, color: STAGE_COLORS[stageManagerDraft.length % STAGE_COLORS.length] });
  inp.value='';
  renderStageManagerRows();
}
function saveStageManager(){
  const validIds = new Set(stageManagerDraft.map(s=>s.id));
  const fallbackId = stageManagerDraft[0] ? stageManagerDraft[0].id : null;
  leads.forEach(l=>{
    if(!validIds.has(l.stageId)){
      l.stageId = fallbackId;
      markReached(l, fallbackId, Date.now());
      persistLead(l);
    }
  });
  stages = stageManagerDraft;
  window.crmFirebase.savePipeline(stages);
  closeStageManager();
  refreshAll();
  showToast('✓ Pipeline stages updated');
}

// ═══════ FOLLOW-UP WHATSAPP DIGEST MANAGER ═══════
function openDigestManager(){
  digestSettingsDraft = {
    enabled: digestSettings.enabled, recipients: digestSettings.recipients.slice(),
    emailEnabled: digestSettings.emailEnabled, emails: digestSettings.emails.slice()
  };
  document.getElementById('digestEnabled').checked = digestSettingsDraft.enabled;
  document.getElementById('digestEmailEnabled').checked = digestSettingsDraft.emailEnabled;
  renderDigestRecipientRows();
  renderDigestEmailRows();
  document.getElementById('digestModal').classList.add('open');
}
function closeDigestManager(){
  document.getElementById('digestModal').classList.remove('open');
}
function renderDigestRecipientRows(){
  document.getElementById('digestRecipientRows').innerHTML = digestSettingsDraft.recipients.map((r,i)=>`
    <div class="req-info-row">
      <input type="text" value="${escapeHtml(r)}" oninput="renameDigestRecipientDraft(${i}, this.value)">
      <button class="stage-del" aria-label="Remove recipient ${escapeHtml(r)}" onclick="removeDigestRecipientDraft(${i})">🗑️</button>
    </div>`).join('');
}
function renameDigestRecipientDraft(i, val){ digestSettingsDraft.recipients[i] = val; }
function removeDigestRecipientDraft(i){ digestSettingsDraft.recipients.splice(i,1); renderDigestRecipientRows(); }
function addDigestRecipientDraft(){
  const inp = document.getElementById('newDigestRecipient');
  const val = inp.value.trim();
  if(!val) return;
  digestSettingsDraft.recipients.push(val);
  inp.value='';
  renderDigestRecipientRows();
}
function renderDigestEmailRows(){
  document.getElementById('digestEmailRows').innerHTML = digestSettingsDraft.emails.map((r,i)=>`
    <div class="req-info-row">
      <input type="text" value="${escapeHtml(r)}" oninput="renameDigestEmailDraft(${i}, this.value)">
      <button class="stage-del" aria-label="Remove email ${escapeHtml(r)}" onclick="removeDigestEmailDraft(${i})">🗑️</button>
    </div>`).join('');
}
function renameDigestEmailDraft(i, val){ digestSettingsDraft.emails[i] = val; }
function removeDigestEmailDraft(i){ digestSettingsDraft.emails.splice(i,1); renderDigestEmailRows(); }
function addDigestEmailDraft(){
  const inp = document.getElementById('newDigestEmail');
  const val = inp.value.trim();
  if(!val) return;
  digestSettingsDraft.emails.push(val);
  inp.value='';
  renderDigestEmailRows();
}
function syncDigestDraftFromForm(){
  digestSettingsDraft.enabled = document.getElementById('digestEnabled').checked;
  digestSettingsDraft.emailEnabled = document.getElementById('digestEmailEnabled').checked;
}
function saveDigestManager(){
  syncDigestDraftFromForm();
  window.crmFirebase.saveFollowupDigestSettings(digestSettingsDraft.enabled, digestSettingsDraft.recipients, digestSettingsDraft.emailEnabled, digestSettingsDraft.emails);
  digestSettings = {
    enabled: digestSettingsDraft.enabled, recipients: digestSettingsDraft.recipients.slice(),
    emailEnabled: digestSettingsDraft.emailEnabled, emails: digestSettingsDraft.emails.slice()
  };
  closeDigestManager();
  showToast('✓ Digest settings saved');
}
async function sendDigestNow(){
  syncDigestDraftFromForm();
  if(!digestSettingsDraft.recipients.length && !digestSettingsDraft.emails.length){
    showToast('Add at least one WhatsApp number or email first');
    return;
  }
  saveDigestManager();
  showToast('Sending digest…');
  try{
    const idToken = await window.crmAuth.getIdToken();
    const res = await fetch('/api/followup-digest', {
      method:'POST',
      headers:{ 'Authorization':'Bearer '+idToken }
    });
    const data = await res.json().catch(()=>({}));
    if(!res.ok){ showToast(data.error || 'Send failed'); return; }
    const results = data.results || [];
    const okCount = results.filter(r=>r.ok).length;
    const failCount = results.length - okCount;
    if(!results.length) showToast('Nothing to send — no recipients configured');
    else if(!failCount) showToast(`✓ Digest sent to ${okCount} recipient${okCount===1?'':'s'}`);
    else showToast(`Sent to ${okCount}, ${failCount} failed — check console`);
    if(failCount) console.error('Digest send failures:', results.filter(r=>!r.ok));
  } catch(e){
    console.error('sendDigestNow error:', e);
    showToast('Send failed — see console');
  }
}

// ═══════ DASHBOARD SUMMARY EMAIL MANAGER ═══════
// Mirrors the Follow-up Digest manager above exactly (same modal pattern,
// same save/send plumbing) — see openDigestManager() for the reference.
function openDashboardEmailManager(){
  // First time this tenant ever opens it: default to whatever Follow-up
  // Digest's email list currently is. From then on it's fully independent.
  const startingRecipients = dashboardEmailSettings.recipients === null
    ? digestSettings.emails.slice()
    : dashboardEmailSettings.recipients.slice();
  dashboardEmailSettingsDraft = { enabled: dashboardEmailSettings.enabled, recipients: startingRecipients };
  document.getElementById('dashboardEmailEnabled').checked = dashboardEmailSettingsDraft.enabled;
  renderDashboardEmailRows();
  document.getElementById('dashboardEmailModal').classList.add('open');
}
function closeDashboardEmailManager(){
  document.getElementById('dashboardEmailModal').classList.remove('open');
}
function renderDashboardEmailRows(){
  document.getElementById('dashboardEmailRows').innerHTML = dashboardEmailSettingsDraft.recipients.map((r,i)=>`
    <div class="req-info-row">
      <input type="text" value="${escapeHtml(r)}" oninput="renameDashboardEmailDraft(${i}, this.value)">
      <button class="stage-del" aria-label="Remove email ${escapeHtml(r)}" onclick="removeDashboardEmailDraft(${i})">🗑️</button>
    </div>`).join('');
}
function renameDashboardEmailDraft(i, val){ dashboardEmailSettingsDraft.recipients[i] = val; }
function removeDashboardEmailDraft(i){ dashboardEmailSettingsDraft.recipients.splice(i,1); renderDashboardEmailRows(); }
function addDashboardEmailDraft(){
  const inp = document.getElementById('newDashboardEmail');
  const val = inp.value.trim();
  if(!val) return;
  dashboardEmailSettingsDraft.recipients.push(val);
  inp.value='';
  renderDashboardEmailRows();
}
function syncDashboardEmailDraftFromForm(){
  dashboardEmailSettingsDraft.enabled = document.getElementById('dashboardEmailEnabled').checked;
}
function saveDashboardEmailManager(){
  syncDashboardEmailDraftFromForm();
  window.crmFirebase.saveDashboardEmailSettings(dashboardEmailSettingsDraft.enabled, dashboardEmailSettingsDraft.recipients);
  dashboardEmailSettings = { enabled: dashboardEmailSettingsDraft.enabled, recipients: dashboardEmailSettingsDraft.recipients.slice() };
  closeDashboardEmailManager();
  showToast('✓ Dashboard email settings saved');
}
async function sendDashboardEmailNow(){
  syncDashboardEmailDraftFromForm();
  if(!dashboardEmailSettingsDraft.recipients.length){
    showToast('Add at least one email address first');
    return;
  }
  saveDashboardEmailManager();
  showToast('Sending dashboard summary…');
  try{
    const idToken = await window.crmAuth.getIdToken();
    const res = await fetch('/api/dashboard-summary', {
      method:'POST',
      headers:{ 'Authorization':'Bearer '+idToken }
    });
    const data = await res.json().catch(()=>({}));
    if(!res.ok){ showToast(data.error || 'Send failed'); return; }
    const results = data.results || [];
    const okCount = results.filter(r=>r.ok).length;
    const failCount = results.length - okCount;
    if(!results.length) showToast('Nothing to send — no recipients configured');
    else if(!failCount) showToast(`✓ Dashboard summary sent to ${okCount} recipient${okCount===1?'':'s'}`);
    else showToast(`Sent to ${okCount}, ${failCount} failed — check console`);
    if(failCount) console.error('Dashboard summary send failures:', results.filter(r=>!r.ok));
  } catch(e){
    console.error('sendDashboardEmailNow error:', e);
    showToast('Send failed — see console');
  }
}

// ═══════ AI BOT EDITOR ═══════
const DEFAULT_BOT_CONFIG_CLIENT = {
  role: 'You are a professional, friendly real estate assistant for 3 PIN Realty, a real estate brokerage in Chennai. You help potential buyers find properties by understanding their requirements through natural conversation.',
  welcomeMessage: "Hi! Thanks for reaching out to 3 PIN Realty 👋 What are you looking for in Chennai — an apartment, villa, or plot?",
  requiredInfo: [
    { id:'ri1', label:'Preferred area in Chennai' },
    { id:'ri2', label:'Budget' },
    { id:'ri3', label:'Property type and configuration (e.g. 2BHK apartment, villa)' },
    { id:'ri4', label:'Name' }
  ],
  steps: [
    { id:'s1', title:'Hook & Qualify', instructions:'Acknowledge the enquiry immediately. Ask only for what is missing — do not repeat questions already answered. Gather naturally, not like a form.' },
    { id:'s2', title:'Share Matching Options', instructions:'Once you have area, budget, and type, let them know a team member will follow up with matching properties. Do not invent specific listings, prices, or availability you were not given.' },
    { id:'s3', title:'Close & Handoff', instructions:'Once you have the required info, thank them and let them know a team member will follow up shortly.' }
  ],
  guardrails: [
    'Never invent specific property prices, availability, or details you have not been given.',
    'If asked for legal, financial, or loan advice, say a team member will follow up on that.',
    'If the user seems frustrated, confused, or explicitly asks for a human, stop qualifying and say a team member will take over.',
    'Keep replies short — 1-3 sentences, WhatsApp style, not long paragraphs.'
  ],
  tone: 'Warm, professional, concise. Natural conversation — never sound like filling out a form.',
  waPhoneNumber: '',
  waPhoneNumberId: ''
};
let botConfigDraft = null;
let botTestHistory = [];

async function openBotEditor(){
  document.getElementById('botEditorPanel').classList.add('open');
  const saved = await window.crmFirebase.getBotConfig();
  botConfigDraft = saved ? JSON.parse(JSON.stringify(saved)) : JSON.parse(JSON.stringify(DEFAULT_BOT_CONFIG_CLIENT));
  renderBotEditorForm();
  botTestHistory = [];
  renderBotChat();
  loadKnowledge();
}
function closeBotEditor(){
  document.getElementById('botEditorPanel').classList.remove('open');
}

function renderBotEditorForm(){
  document.getElementById('botRole').value = botConfigDraft.role || '';
  document.getElementById('botWelcome').value = botConfigDraft.welcomeMessage || '';
  document.getElementById('botTone').value = botConfigDraft.tone || '';
  updateWaConnectionStatus();
  renderRequiredInfoRows();
  renderStepsRows();
  renderGuardrailsRows();
}

function updateWaConnectionStatus(){
  const connected = !!(botConfigDraft.waPhoneNumberId && botConfigDraft.waConnectedAt);
  const statusEl = document.getElementById('waConnectionStatus');
  const disconnectedBody = document.getElementById('waDisconnectedBody');
  const connectedBody = document.getElementById('waConnectedBody');
  const subEl = document.getElementById('waCardSub');

  statusEl.textContent = connected ? 'Verified' : 'Not connected';
  statusEl.className = 'connect-status ' + (connected ? 'connected' : 'disconnected');
  disconnectedBody.style.display = connected ? 'none' : 'block';
  connectedBody.style.display = connected ? 'block' : 'none';

  if(connected){
    const num = botConfigDraft.waPhoneNumber || botConfigDraft.waPhoneNumberId;
    subEl.textContent = botConfigDraft.waVerifiedName || 'Connected';
    document.getElementById('waVerifiedText').textContent = num;
    const meta = [];
    if(botConfigDraft.waVerifiedName) meta.push('Name: ' + botConfigDraft.waVerifiedName);
    if(botConfigDraft.waQualityRating) meta.push('Quality: ' + botConfigDraft.waQualityRating);
    meta.push('ID: ' + botConfigDraft.waPhoneNumberId);
    document.getElementById('waVerifiedMeta').innerHTML = meta.map(m=>`<span>${m}</span>`).join('');
  } else {
    subEl.textContent = 'Not connected';
  }
  renderWorkflowCanvas();
}

// ═══════ WORKFLOW CANVAS ═══════
function renderWorkflowCanvas(){
  const el = document.getElementById('wfCanvas');
  if(!el || !botConfigDraft) return;

  const sheets = knowledgeSources.filter(s => /sheet/i.test(s.type||''));
  const docs = knowledgeSources.filter(s => !/sheet/i.test(s.type||''));
  const waOn = !!(botConfigDraft.waPhoneNumberId && botConfigDraft.waConnectedAt);
  const agentOn = waOn && knowledgeSources.length > 0;

  const node = (opts) => {
    const cls = 'wf-node' + (opts.cls ? ' '+opts.cls : '');
    const click = opts.onclick ? ` onclick="${opts.onclick}"` : '';
    const pill = opts.pill ? `<span class="wf-pill ${opts.pill.k}">${opts.pill.t}</span>` : '';
    return `<div class="${cls}"${click}>
      <div class="wf-node-top"><span class="wf-ico">${opts.ico}</span>${pill}</div>
      <div class="wf-node-name">${opts.name}</div>
      <div class="wf-node-desc">${opts.desc}</div>
    </div>`;
  };

  const knowledgeNode = node({
    ico:'📚', name:'Knowledge',
    desc: docs.length ? `${docs.length} doc${docs.length>1?'s':''}/file${docs.length>1?'s':''}` : 'Add docs & PDFs',
    pill: docs.length ? {k:'on',t:'Connected'} : {k:'off',t:'Empty'},
    onclick:"openWfSection('secKnowledge')"
  });
  const sheetNode = node({
    ico:'📊', name:'Google Sheet',
    desc: sheets.length ? `${sheets.length} sheet${sheets.length>1?'s':''} linked` : 'Link a sheet',
    pill: sheets.length ? {k:'on',t:'Linked'} : {k:'off',t:'Empty'},
    onclick:"openWfSection('secKnowledge')"
  });
  const agentNode = node({
    cls:'agent', ico:'🤖', name:"3 PIN Agent",
    desc: agentOn ? 'Live & answering' : 'Connect a channel to go live',
    pill: agentOn ? {k:'on',t:'Active'} : {k:'warn',t:'Inactive'},
    onclick:"openWfSection('secPersona')"
  });
  const waNode = node({
    ico:'🟢', name:'WhatsApp',
    desc: waOn ? (botConfigDraft.waPhoneNumber||'Connected') : 'Click to connect',
    pill: waOn ? {k:'on',t:'Verified'} : {k:'off',t:'Connect'},
    onclick:"openWfSection('secChannels')"
  });
  const igNode = node({ cls:'soon', ico:'📸', name:'Instagram', desc:'Coming soon', pill:{k:'off',t:'Soon'} });
  const webNode = node({ cls:'soon', ico:'🌐', name:'Website', desc:'Coming soon', pill:{k:'off',t:'Soon'} });

  el.innerHTML =
    `<div class="wf-col">${knowledgeNode}${sheetNode}</div>` +
    `<div class="wf-rail"></div>` +
    `<div class="wf-col center">${agentNode}</div>` +
    `<div class="wf-rail"></div>` +
    `<div class="wf-col">${waNode}${igNode}${webNode}</div>`;
}

function openWfSection(id){
  const sec = document.getElementById(id);
  if(!sec) return;
  sec.scrollIntoView({ behavior:'smooth', block:'center' });
  sec.classList.add('wf-flash');
  setTimeout(()=>sec.classList.remove('wf-flash'), 1200);
}

// Meta Embedded Signup Configuration ID comes from /api/public-config (see
// crm.html), which serves it from the META_EMBEDDED_SIGNUP_CONFIG_ID Vercel
// env var — not hardcoded here, so it's set in exactly one place.
let waSignupSessionInfo = null;
let waSessionInfoResolvers = [];
let publicConfig = null;
(window.__publicConfigPromise || Promise.resolve({})).then(cfg => { publicConfig = cfg; });

// Exact allowlist, not endsWith — "evilfacebook.com" ends with "facebook.com"
// too, so a substring/suffix check here would let an attacker-controlled
// page inject a fake WA_EMBEDDED_SIGNUP message with a spoofed phone number.
const META_MESSAGE_ORIGINS = ['https://www.facebook.com', 'https://web.facebook.com', 'https://m.facebook.com'];
let waSignupAttemptId = 0;

window.addEventListener('message', (event) => {
  if (!META_MESSAGE_ORIGINS.includes(event.origin)) return;
  let data;
  try { data = JSON.parse(event.data); } catch { return; }
  if (data.type === 'WA_EMBEDDED_SIGNUP' && data.event === 'FINISH') {
    waSignupSessionInfo = data.data; // { phone_number_id, waba_id }
    waSessionInfoResolvers.forEach(r => r(data.data));
    waSessionInfoResolvers = [];
  }
});

// Tagged with the attempt id at call time so a message that arrives late
// from a cancelled/timed-out earlier attempt can't be mistaken for the
// current one's session info.
function waitForWaSessionInfo(timeoutMs, attemptId){
  if (waSignupSessionInfo && attemptId === waSignupAttemptId) return Promise.resolve(waSignupSessionInfo);
  return new Promise(resolve => {
    const wrapped = (info) => { if (attemptId === waSignupAttemptId) resolve(info); };
    waSessionInfoResolvers.push(wrapped);
    setTimeout(() => { if (attemptId === waSignupAttemptId) resolve(waSignupSessionInfo); }, timeoutMs);
  });
}

function connectWhatsApp(){
  // Must call FB.login() synchronously, in direct response to the click —
  // any `await` (even a resolved promise's microtask) before it makes
  // browsers treat the resulting window.open() as NOT user-initiated, and
  // they silently block the popup instead of opening it. That's why the
  // public config is pre-fetched into `publicConfig` at load time rather
  // than awaited here.
  const note = document.getElementById('waConnectNote');
  if (typeof FB === 'undefined'){
    note.textContent = 'Meta SDK failed to load — check your connection and try again.';
    note.style.color = 'var(--red)';
    return;
  }
  if (!publicConfig || !publicConfig.metaEmbeddedSignupConfigId){
    note.textContent = 'Meta config is still loading — wait a second and try again.';
    note.style.color = 'var(--red)';
    return;
  }
  const btn = document.getElementById('waConnectBtn');
  btn.disabled = true; btn.textContent = 'Connecting…';
  waSignupSessionInfo = null;
  const attemptId = ++waSignupAttemptId;
  FB.login((response) => handleFbLoginResponse(response, attemptId), {
    config_id: publicConfig.metaEmbeddedSignupConfigId,
    response_type: 'code',
    override_default_response_type: true,
    extras: { setup: {}, featureType: '', sessionInfoVersion: '2' }
  });
}

async function handleFbLoginResponse(response, attemptId){
  const btn = document.getElementById('waConnectBtn');
  const note = document.getElementById('waConnectNote');
  const resetBtn = () => { btn.disabled = false; btn.innerHTML = '<span class="wa-glyph">✆</span> Connect WhatsApp via Meta'; };

  if (!response.authResponse || !response.authResponse.code){
    note.textContent = 'Connection cancelled.';
    note.style.color = 'var(--red)';
    resetBtn();
    return;
  }

  try{
    const sessionInfo = await waitForWaSessionInfo(4000, attemptId);
    if (!sessionInfo || !sessionInfo.phone_number_id){
      note.textContent = 'Could not read the connected number from Meta — please try again.';
      note.style.color = 'var(--red)';
      return;
    }
    const idToken = await window.crmAuth.getIdToken();
    const res = await fetch('/api/whatsapp-embedded-signup', {
      method:'POST',
      headers:{ 'Content-Type':'application/json', 'Authorization':'Bearer '+idToken },
      body: JSON.stringify({
        code: response.authResponse.code,
        phoneNumberId: sessionInfo.phone_number_id,
        wabaId: sessionInfo.waba_id
      })
    });
    const data = await res.json().catch(()=>({}));
    if(!data.connected){
      note.textContent = data.error || 'Could not connect. Please try again.';
      note.style.color = 'var(--red)';
      return;
    }
    // Persist verified fields into the draft so a later "Save Workflow" won't wipe them.
    botConfigDraft.waPhoneNumberId = data.phoneNumberId;
    botConfigDraft.waPhoneNumber = data.displayPhoneNumber || '';
    botConfigDraft.waVerifiedName = data.verifiedName || '';
    botConfigDraft.waQualityRating = data.qualityRating || '';
    botConfigDraft.waConnectedAt = Date.now();
    updateWaConnectionStatus();
    showToast('✓ WhatsApp connected');
  } catch(e){
    console.error('connectWhatsApp error:', e);
    note.textContent = 'Connection failed — see console.';
    note.style.color = 'var(--red)';
  } finally {
    resetBtn();
  }
}

async function disconnectWhatsApp(){
  if(!confirm('Disconnect this WhatsApp number from the bot?')) return;
  try{
    const idToken = await window.crmAuth.getIdToken();
    await fetch('/api/whatsapp-embedded-signup', {
      method:'DELETE',
      headers:{ 'Authorization':'Bearer '+idToken }
    });
  } catch(e){ console.error('disconnectWhatsApp error:', e); }
  botConfigDraft.waPhoneNumberId = '';
  botConfigDraft.waPhoneNumber = '';
  botConfigDraft.waVerifiedName = '';
  botConfigDraft.waQualityRating = '';
  botConfigDraft.waConnectedAt = null;
  updateWaConnectionStatus();
  showToast('WhatsApp disconnected');
}

function syncBotDraftFromForm(){
  botConfigDraft.role = document.getElementById('botRole').value;
  botConfigDraft.welcomeMessage = document.getElementById('botWelcome').value;
  botConfigDraft.tone = document.getElementById('botTone').value;
  // WhatsApp fields are managed by the connect/disconnect flow, not this form.
}

function renderRequiredInfoRows(){
  document.getElementById('botRequiredInfoRows').innerHTML = botConfigDraft.requiredInfo.map((r,i)=>`
    <div class="req-info-row">
      <input type="text" aria-label="Required info" value="${escapeHtml(r.label)}" oninput="renameRequiredInfoDraft(${i}, this.value)">
      <button class="stage-del" aria-label="Remove ${escapeHtml(r.label)}" onclick="removeRequiredInfoDraft(${i})">🗑️</button>
    </div>`).join('');
}
function renameRequiredInfoDraft(i, val){ botConfigDraft.requiredInfo[i].label = val; }
function removeRequiredInfoDraft(i){ botConfigDraft.requiredInfo.splice(i,1); renderRequiredInfoRows(); }
function addRequiredInfoDraft(){
  const inp = document.getElementById('newRequiredInfo');
  const label = inp.value.trim();
  if(!label) return;
  botConfigDraft.requiredInfo.push({ id:'ri_'+Date.now(), label });
  inp.value='';
  renderRequiredInfoRows();
}

function renderStepsRows(){
  document.getElementById('botStepsRows').innerHTML = botConfigDraft.steps.map((s,i)=>`
    <div class="step-row">
      <div class="step-row-hdr">
        <button class="stage-move" aria-label="Move step up" onclick="moveStepDraft(${i},-1)" ${i===0?'disabled':''}>↑</button>
        <button class="stage-move" aria-label="Move step down" onclick="moveStepDraft(${i},1)" ${i===botConfigDraft.steps.length-1?'disabled':''}>↓</button>
        <input type="text" aria-label="Step title" value="${escapeHtml(s.title)}" oninput="renameStepTitleDraft(${i}, this.value)">
        <button class="stage-del" aria-label="Remove step ${escapeHtml(s.title)}" onclick="removeStepDraft(${i})">🗑️</button>
      </div>
      <textarea rows="2" aria-label="Step instructions" oninput="renameStepInstructionsDraft(${i}, this.value)">${escapeHtml(s.instructions)}</textarea>
    </div>`).join('');
}
function renameStepTitleDraft(i, val){ botConfigDraft.steps[i].title = val; }
function renameStepInstructionsDraft(i, val){ botConfigDraft.steps[i].instructions = val; }
function moveStepDraft(i, dir){
  const j = i+dir;
  if(j<0 || j>=botConfigDraft.steps.length) return;
  [botConfigDraft.steps[i], botConfigDraft.steps[j]] = [botConfigDraft.steps[j], botConfigDraft.steps[i]];
  renderStepsRows();
}
function removeStepDraft(i){ botConfigDraft.steps.splice(i,1); renderStepsRows(); }
function addStepDraft(){
  botConfigDraft.steps.push({ id:'s_'+Date.now(), title:'New Step', instructions:'' });
  renderStepsRows();
}

function renderGuardrailsRows(){
  document.getElementById('botGuardrailsRows').innerHTML = botConfigDraft.guardrails.map((g,i)=>`
    <div class="req-info-row">
      <input type="text" aria-label="Guardrail" value="${escapeHtml(g)}" oninput="renameGuardrailDraft(${i}, this.value)">
      <button class="stage-del" aria-label="Remove guardrail" onclick="removeGuardrailDraft(${i})">🗑️</button>
    </div>`).join('');
}
function renameGuardrailDraft(i, val){ botConfigDraft.guardrails[i] = val; }
function removeGuardrailDraft(i){ botConfigDraft.guardrails.splice(i,1); renderGuardrailsRows(); }
function addGuardrailDraft(){
  const inp = document.getElementById('newGuardrail');
  const val = inp.value.trim();
  if(!val) return;
  botConfigDraft.guardrails.push(val);
  inp.value='';
  renderGuardrailsRows();
}

function saveBotConfig(){
  syncBotDraftFromForm();
  updateWaConnectionStatus();
  window.crmFirebase.saveBotConfig(botConfigDraft);
  showToast('✓ Workflow saved');
}

function renderBotChat(){
  const win = document.getElementById('botChatWindow');
  if(!botTestHistory.length){
    win.innerHTML = '<div class="bot-chat-empty">Send a message to test the bot with your current draft workflow.</div>';
    return;
  }
  win.innerHTML = botTestHistory.map(m=>`<div class="bot-msg ${m.role}">${m.content}</div>`).join('');
  win.scrollTop = win.scrollHeight;
}

async function sendBotTestMessage(){
  const inp = document.getElementById('botTestInput');
  const text = inp.value.trim();
  if(!text) return;
  syncBotDraftFromForm();
  botTestHistory.push({ role:'user', content:text });
  inp.value='';
  renderBotChat();
  try{
    const idToken = await window.crmAuth.getIdToken();
    const res = await fetch('/api/bot-test-message', {
      method:'POST',
      headers:{ 'Content-Type':'application/json', 'Authorization':'Bearer '+idToken },
      body: JSON.stringify({ config: botConfigDraft, history: botTestHistory })
    });
    if(!res.ok){
      const err = await res.json().catch(()=>({}));
      throw new Error(err.error || ('HTTP '+res.status));
    }
    const data = await res.json();
    botTestHistory.push({ role:'assistant', content:data.reply || '(no reply)' });
    renderBotChat();
  } catch(e){
    console.error('Bot test message error:', e);
    showToast('Test message failed — see console');
  }
}
function clearBotTestChat(){
  botTestHistory = [];
  renderBotChat();
}

// ═══════ KNOWLEDGE BASE ═══════
let knowledgeSources = [];

async function kbFetch(method, body){
  const idToken = await window.crmAuth.getIdToken();
  const opts = { method, headers:{ 'Authorization':'Bearer '+idToken } };
  if(body){ opts.headers['Content-Type']='application/json'; opts.body=JSON.stringify(body); }
  const res = await fetch('/api/knowledge-sync', opts);
  const data = await res.json().catch(()=>({}));
  if(data.error) throw new Error(data.error);
  return data;
}

async function loadKnowledge(){
  try{
    const data = await kbFetch('GET');
    knowledgeSources = data.sources || [];
  } catch(e){
    console.error('loadKnowledge error:', e);
    knowledgeSources = [];
  }
  renderKnowledgeList();
}

function renderKnowledgeList(){
  renderWorkflowCanvas();
  const el = document.getElementById('kbSourceList');
  if(!knowledgeSources.length){
    el.innerHTML = '<div class="kb-empty">No knowledge connected yet. Add a sheet, doc, or file above.</div>';
    return;
  }
  el.innerHTML = knowledgeSources.map(s=>{
    const when = s.syncedAt ? new Date(s.syncedAt).toLocaleDateString() : '';
    const chars = s.chars ? (s.chars>999 ? (s.chars/1000).toFixed(1)+'k' : s.chars) + ' chars' : '';
    const resync = s.url ? `<button class="kb-src-act" onclick="resyncKnowledge('${s.id}')">↻ Sync</button>` : '';
    return `<div class="kb-src">
      <div class="kb-src-icon">${s.url ? '🔗' : '📄'}</div>
      <div class="kb-src-body">
        <div class="kb-src-name">${escapeHtml(s.name||'Source')}</div>
        <div class="kb-src-meta">${escapeHtml(s.type||'')} · ${chars} · synced ${when}</div>
      </div>
      <div class="kb-src-acts">${resync}<button class="kb-src-act del" onclick="removeKnowledge('${s.id}')">🗑️</button></div>
    </div>`;
  }).join('');
}

function escapeHtml(str){
  return String(str).replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

async function addKnowledgeLink(){
  const url = document.getElementById('kbLinkUrl').value.trim();
  const name = document.getElementById('kbLinkName').value.trim();
  if(!url){ showToast('Paste a Google Sheet or Doc link'); return; }
  showToast('Connecting link…');
  try{
    const data = await kbFetch('POST', { action:'addLink', url, name });
    knowledgeSources.push(data.source);
    document.getElementById('kbLinkUrl').value='';
    document.getElementById('kbLinkName').value='';
    renderKnowledgeList();
    showToast('✓ Knowledge added');
  } catch(e){
    console.error(e); showToast(e.message || 'Could not add link');
  }
}

function toggleKbPaste(){
  const box = document.getElementById('kbPasteBox');
  box.style.display = box.style.display==='none' ? 'block' : 'none';
}

async function addKnowledgePaste(){
  const name = document.getElementById('kbPasteName').value.trim();
  const content = document.getElementById('kbPasteContent').value.trim();
  if(!content){ showToast('Paste some text first'); return; }
  try{
    const data = await kbFetch('POST', { action:'addText', name: name||'Pasted text', sourceType:'Text', content });
    knowledgeSources.push(data.source);
    document.getElementById('kbPasteName').value='';
    document.getElementById('kbPasteContent').value='';
    document.getElementById('kbPasteBox').style.display='none';
    renderKnowledgeList();
    showToast('✓ Knowledge added');
  } catch(e){ console.error(e); showToast(e.message || 'Could not add text'); }
}

async function uploadKnowledgeFile(event){
  const file = event.target.files[0];
  event.target.value = '';
  if(!file) return;
  showToast('Reading ' + file.name + '…');
  try{
    let text = '';
    if(file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')){
      text = await extractPdfText(file);
    } else {
      text = await file.text();
    }
    if(!text.trim()){ showToast('No readable text found in that file'); return; }
    const data = await kbFetch('POST', { action:'addText', name:file.name, sourceType: file.name.split('.').pop().toUpperCase(), content:text });
    knowledgeSources.push(data.source);
    renderKnowledgeList();
    showToast('✓ ' + file.name + ' added');
  } catch(e){ console.error(e); showToast(e.message || 'Could not read file'); }
}

async function extractPdfText(file){
  if(!window.pdfjsLib) throw new Error('PDF reader not loaded — try again');
  const buf = await file.arrayBuffer();
  // isEvalSupported:false disarms CVE-2024-4367 — a crafted PDF can otherwise
  // run arbitrary JS in this (logged-in) origin via pdf.js's font eval path.
  // Kept even after the version bump below, as defence-in-depth.
  const pdf = await window.pdfjsLib.getDocument({ data: buf, isEvalSupported: false }).promise;
  let out = '';
  const pages = Math.min(pdf.numPages, 50);
  for(let i=1;i<=pages;i++){
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    out += content.items.map(it=>it.str).join(' ') + '\n';
  }
  return out;
}

async function resyncKnowledge(id){
  showToast('Re-syncing…');
  try{
    const data = await kbFetch('POST', { action:'resync', id });
    const idx = knowledgeSources.findIndex(s=>s.id===id);
    if(idx>=0) knowledgeSources[idx] = data.source;
    renderKnowledgeList();
    showToast('✓ Synced');
  } catch(e){ console.error(e); showToast(e.message || 'Sync failed'); }
}

async function removeKnowledge(id){
  try{
    await kbFetch('POST', { action:'remove', id });
    knowledgeSources = knowledgeSources.filter(s=>s.id!==id);
    renderKnowledgeList();
    showToast('Removed');
  } catch(e){ console.error(e); showToast('Could not remove'); }
}

function connectGoogleDrive(){
  // Placeholder for the full OAuth Drive Picker (needs a one-time Google Cloud
  // OAuth client + Picker API key). Until that's configured, the paste-a-link
  // flow above already covers Sheets & Docs with no setup.
  showToast('Google Drive picker needs one-time OAuth setup — use "Connect" with a shared link for now');
}


// ═══════ TOAST ═══════
function showToast(msg){
  const t=document.getElementById('toast');t.textContent=msg;t.classList.add('show');
  // Cleared on hide as well as set on show: #toast is only faded to opacity:0,
  // so a node left holding stale text is still read out by a screen reader.
  clearTimeout(toastTimer);toastTimer=setTimeout(()=>{t.classList.remove('show');t.textContent='';},2400);
}

// ═══════ LAYERS: FOCUS, ESCAPE AND SCROLL LOCK ═══════
// Every overlay in this app opens the same way — a `.open` class on a fixed,
// full-viewport element — so one observer can give all of them the dialog
// behaviour they were each missing, without touching fifteen open/close
// functions and risking their individual logic.
const LAYER_SEL = '.modal-overlay, #dp, #botEditorPanel';
const LAYER_CLOSERS = {
  lModal: closeLeadModal, dupModal: closeDupModal, stageModal: closeStageManager,
  fuLogModal: closeFollowUpLogModal, digestModal: closeDigestManager,
  dashboardEmailModal: closeDashboardEmailManager, stageReasonModal: closeStageReasonModal,
  exportModal: closeExportModal, dp: closeDetail, botEditorPanel: closeBotEditor
};
const layerReturnFocus = new WeakMap();

function openLayers(){
  // Painted order, so the last entry is the one actually on top.
  return [...document.querySelectorAll(LAYER_SEL)]
    .filter(el => el.classList.contains('open'))
    .sort((a,b) => (parseInt(getComputedStyle(a).zIndex) || 0) - (parseInt(getComputedStyle(b).zIndex) || 0));
}
function topLayer(){ const l = openLayers(); return l[l.length - 1] || null; }

function focusablesIn(el){
  return [...el.querySelectorAll('a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])')]
    .filter(n => n.offsetParent !== null || n === document.activeElement);
}

function onLayerOpened(el){
  layerReturnFocus.set(el, document.activeElement);
  // The page behind is inert to assistive tech, matching what sighted users
  // see: a dimmed, unreachable board.
  const root = document.getElementById('appRoot');
  const f = focusablesIn(el);
  // Prefer the first real field over the close button, which is first in DOM.
  const target = el.querySelector('.modal-body input:not([type=hidden]),.modal-body select,.modal-body textarea') || f[0];
  if(target) try{ target.focus({ preventScroll:true }); }catch(e){ target.focus(); }
  syncLayerState(root);
}
function onLayerClosed(el){
  const prev = layerReturnFocus.get(el);
  layerReturnFocus.delete(el);
  syncLayerState(document.getElementById('appRoot'));
  // Only restore if nothing else took focus meanwhile, and the element is still
  // in the document — otherwise focus silently falls to <body> and the user is
  // dropped at the top of the page.
  if(prev && prev.isConnected && !topLayer()){
    try{ prev.focus({ preventScroll:true }); }catch(e){}
  }
}
function syncLayerState(root){
  const any = openLayers().length > 0;
  // Scroll lock: without it a flick inside a modal scroll-chains to the board
  // behind it, so closing the modal lands somewhere else entirely.
  document.body.classList.toggle('layer-open', any);
  if(root) root.toggleAttribute('inert', any && !root.contains(topLayer()));
}

new MutationObserver(muts => {
  muts.forEach(m => {
    if(m.attributeName !== 'class') return;
    const el = m.target;
    if(!el.matches || !el.matches(LAYER_SEL)) return;
    const now = el.classList.contains('open');
    const was = el.dataset.layerOpen === '1';
    if(now === was) return;
    el.dataset.layerOpen = now ? '1' : '0';
    now ? onLayerOpened(el) : onLayerClosed(el);
  });
}).observe(document.documentElement, { attributes:true, subtree:true, attributeFilter:['class'] });

document.addEventListener('keydown', e => {
  if(e.key === 'Escape'){
    // Close only the topmost layer. Closing all of them meant that pressing
    // Escape in the Edit modal also closed the lead behind it, dumping you back
    // on the board having lost your place.
    const top = topLayer();
    if(top){
      e.preventDefault();
      const fn = LAYER_CLOSERS[top.id];
      fn ? fn() : top.classList.remove('open');
      return;
    }
    // No layer open — fall through to the lightweight popups. The rail
    // handles its own Escape, in appnav.js.
    closeMoreMenu(); closePropertyPop();
    return;
  }
  if(e.key === 'Tab'){
    // Focus trap: Tab used to walk straight out of an open dialog into the
    // header buttons behind it.
    const top = topLayer();
    if(!top) return;
    const f = focusablesIn(top);
    if(!f.length) return;
    const first = f[0], last = f[f.length - 1];
    if(e.shiftKey && (document.activeElement === first || !top.contains(document.activeElement))){
      e.preventDefault(); last.focus();
    } else if(!e.shiftKey && document.activeElement === last){
      e.preventDefault(); first.focus();
    }
  }
});

// ═══════ ROVING FOCUS FOR TOOLBARS AND TABS ═══════
// The filter rows, the timeline filters, the bulk bar and the TailorTalk tabs
// all declare role="toolbar" / role="tablist". Those roles are a promise that
// arrow keys move between the items and that the group is ONE tab stop — a
// declared role that does nothing is worse than no role, because a screen
// reader announces the contract and then it isn't honoured. One delegated
// handler keeps that promise everywhere rather than per component.
const ROVING_SEL = '[role="toolbar"],[role="tablist"]';
function rovingItems(group){
  return [...group.querySelectorAll('button,a[href],select,input')]
    .filter(el => !el.disabled && el.offsetParent !== null);
}
document.addEventListener('keydown', e => {
  const group = e.target.closest && e.target.closest(ROVING_SEL);
  if(!group) return;
  // Inside a text field the arrows belong to the caret.
  if(/^(INPUT|TEXTAREA)$/.test(e.target.tagName) && !/^(checkbox|radio|button)$/.test(e.target.type)) return;
  if(e.target.tagName === 'SELECT' && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) return;
  const keys = ['ArrowLeft','ArrowRight','Home','End'];
  if(!keys.includes(e.key)) return;
  const items = rovingItems(group);
  const i = items.indexOf(e.target);
  if(i < 0 || items.length < 2) return;
  e.preventDefault();
  const to = e.key === 'Home' ? 0
    : e.key === 'End' ? items.length - 1
    : e.key === 'ArrowRight' ? (i + 1) % items.length
    : (i - 1 + items.length) % items.length;
  items[to].focus();
});
// One tab stop per group: Tab enters at the active item and leaves the group,
// instead of walking through fifteen filter chips to reach the board.
function syncRovingTabstops(root){
  (root || document).querySelectorAll(ROVING_SEL).forEach(group => {
    const items = rovingItems(group);
    if(items.length < 2) return;
    const active = group.querySelector('[aria-selected="true"],[aria-pressed="true"],.at') || items[0];
    items.forEach(el => { el.tabIndex = el === active ? 0 : -1; });
  });
}
// Re-applied after any render, since the chips are rebuilt wholesale each time.
// Coalesced to one pass per frame: the board re-renders every card on any
// change, and doing this per mutation would be hundreds of passes.
let rovingQueued = false;
new MutationObserver(() => {
  if(rovingQueued) return;
  rovingQueued = true;
  requestAnimationFrame(() => { rovingQueued = false; syncRovingTabstops(); });
}).observe(document.documentElement, { childList:true, subtree:true });

// Click the dim area to dismiss — expected of every dialog, and the only exit
// some modals had was their × button.
document.addEventListener('mousedown', e => {
  if(e.target.classList && e.target.classList.contains('modal-overlay') && e.target.classList.contains('open')){
    const fn = LAYER_CLOSERS[e.target.id];
    fn ? fn() : e.target.classList.remove('open');
  }
});

// ═══════ REAL AUTH (Firebase Authentication) ═══════
let crmInited = false;
function attemptCrmLogin(e){
  e.preventDefault();
  const email = document.getElementById('loginUser').value.trim();
  const password = document.getElementById('loginPass').value;
  const errBox = document.getElementById('loginErr');
  errBox.classList.remove('show');
  window.crmAuth.login(email, password).catch(()=>{
    errBox.textContent = 'Invalid email or password.';
    errBox.classList.add('show');
  });
}
function crmLogout(){
  window.crmAuth.logout();
}
function renderUserProfileBadge(){
  const el = document.getElementById('hdrUserEmail');
  if(el) el.textContent = currentUserEmail ? '👤 ' + currentUserEmail : '';
  if(window.AppNav) window.AppNav.setUser(currentUserEmail || '');
}
window.onCrmAuthChange = function(user){
  if(user){
    currentUserEmail = user.email || null;
    renderUserProfileBadge();
    document.getElementById('loginScreen').classList.remove('open');
    document.getElementById('appRoot').style.display = '';
    if(!crmInited){ crmInited = true; init(); }
  } else {
    currentUserEmail = null;
    document.getElementById('loginScreen').classList.add('open');
    document.getElementById('appRoot').style.display = 'none';
  }
};
