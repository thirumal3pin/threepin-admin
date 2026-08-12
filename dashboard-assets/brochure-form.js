// ═══════ CREATE BROCHURE (embedded Google Form submit) ═══════
// Submits directly to the "3 PIN Realty - New Listing Intake" Google Form's
// response endpoint, so the same automation (brochure build + inventory sync)
// still fires — without ever leaving or showing the Google Forms UI.
const BROCHURE_FORM_ACTION = 'https://docs.google.com/forms/d/e/1FAIpQLSdhhCVV3frLlFaN8FXpGB0exOXT2He4VWPnOqTdEUeV82fLMA/formResponse';
const BROCHURE_FIELD_MAP = {
  title:   'entry.1238821452', // Property ID & Title
  drive:   'entry.1785532374', // Google Drive Photo Folder Link
  details: 'entry.134248436'   // Property Details (required)
};

function openBrochureModal(){
  document.getElementById('brochureForm').reset();
  const err = document.getElementById('bfErr');
  err.classList.remove('show');
  err.textContent = '';
  document.getElementById('brochureModal').classList.add('open');
  setTimeout(() => document.getElementById('bfTitle').focus(), 50);
}

function closeBrochureModal(){
  document.getElementById('brochureModal').classList.remove('open');
}

async function submitBrochureForm(){
  const title = document.getElementById('bfTitle').value.trim();
  const drive = document.getElementById('bfDrive').value.trim();
  const details = document.getElementById('bfDetails').value.trim();
  const err = document.getElementById('bfErr');

  if(!details){
    err.textContent = 'Property Details is required.';
    err.classList.add('show');
    document.getElementById('bfDetails').focus();
    return;
  }
  err.classList.remove('show');

  const btn = document.getElementById('bfSubmitBtn');
  btn.disabled = true;
  btn.textContent = 'Submitting…';

  const body = new URLSearchParams();
  body.append(BROCHURE_FIELD_MAP.title, title);
  body.append(BROCHURE_FIELD_MAP.drive, drive);
  body.append(BROCHURE_FIELD_MAP.details, details);

  try {
    // Google Forms' response endpoint doesn't send CORS headers, so the
    // request must be fired "no-cors" — the browser still delivers it,
    // we just can't read the (opaque) response back.
    await fetch(BROCHURE_FORM_ACTION, {
      method: 'POST',
      mode: 'no-cors',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString()
    });
    closeBrochureModal();
    showToast('✓ Submitted — brochure will be ready in ~30 min');
  } catch(e) {
    err.textContent = 'Could not submit — check your connection and try again.';
    err.classList.add('show');
  } finally {
    btn.disabled = false;
    btn.textContent = '✓ Submit';
  }
}

document.getElementById('brochureModal')?.addEventListener('click', e => {
  if(e.target.id === 'brochureModal') closeBrochureModal();
});
