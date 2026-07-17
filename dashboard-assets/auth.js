// ═══════ ADMIN LOGIN GATE ═══════
// Client-side only: hides the dashboard behind a login screen. Does not
// protect the Firestore data itself (see dashboard-assets/firebase-sync.js).
const PIN_ADMIN_USER = 'admin';
const PIN_ADMIN_PASSWORDS = [
  'thirumal@threepin.in',
  'swami@threepin',
  'rajesh@threepin',
  'pradeep@threepin'
];
const PIN_AUTH_KEY = 'pinAdminAuthed';

function pinIsLoggedIn(){
  return localStorage.getItem(PIN_AUTH_KEY) === 'true';
}

function pinShowLogin(){
  document.getElementById('loginScreen').classList.add('open');
  document.getElementById('appRoot').style.display = 'none';
}

function pinShowApp(){
  document.getElementById('loginScreen').classList.remove('open');
  document.getElementById('appRoot').style.display = '';
}

function pinAttemptLogin(e){
  e.preventDefault();
  const u = document.getElementById('loginUser').value.trim();
  const p = document.getElementById('loginPass').value;
  const errBox = document.getElementById('loginErr');
  if(u === PIN_ADMIN_USER && PIN_ADMIN_PASSWORDS.includes(p)){
    localStorage.setItem(PIN_AUTH_KEY, 'true');
    errBox.classList.remove('show');
    pinShowApp();
    if(typeof init === 'function') init();
  } else {
    errBox.textContent = 'Invalid username or password.';
    errBox.classList.add('show');
  }
}

function pinLogout(){
  localStorage.removeItem(PIN_AUTH_KEY);
  location.reload();
}

window.pinAuth = {
  isLoggedIn: pinIsLoggedIn,
  showLogin: pinShowLogin,
  showApp: pinShowApp,
  attemptLogin: pinAttemptLogin,
  logout: pinLogout
};
