// ═══════ ADMIN LOGIN GATE (Firebase Authentication) ═══════
// Same Firebase project, tenant (t_3pinrealty), and login accounts as
// crm.html — log in here with the same email/password. The actual
// signInWithEmailAndPassword / onAuthStateChanged wiring lives in
// dashboard-assets/firebase-sync.js, which exposes window.dashboardAuth
// and calls window.onDashboardAuthChange below on every auth state change.

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
  const email = document.getElementById('loginUser').value.trim();
  const password = document.getElementById('loginPass').value;
  const errBox = document.getElementById('loginErr');
  errBox.classList.remove('show');
  window.dashboardAuth.login(email, password).catch(()=>{
    errBox.textContent = 'Invalid email or password.';
    errBox.classList.add('show');
  });
}

function pinLogout(){
  window.dashboardAuth.logout();
}

window.pinAuth = {
  attemptLogin: pinAttemptLogin,
  logout: pinLogout
};

let dashboardInited = false;
window.onDashboardAuthChange = function(user){
  if(user){
    pinShowApp();
    if(!dashboardInited){ dashboardInited = true; if(typeof init === 'function') init(); }
  } else {
    dashboardInited = false;
    pinShowLogin();
  }
};
