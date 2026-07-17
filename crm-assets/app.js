// Placeholder CRM app logic — build out later.
window.addEventListener('DOMContentLoaded', ()=>{
  if(window.pinAuth && window.pinAuth.isLoggedIn()){
    window.pinAuth.showApp();
  } else {
    window.pinAuth.showLogin();
  }
});
