/* Shared Local Champion application form (mockup: nothing is sent). */
(function () {
  var box = document.getElementById('apply');
  if (!box) return;
  var btn = box.dataset.button || 'Apply to be the local champion';
  box.innerHTML = '<form novalidate>'
    + '<label>ENT practice name<input name="organization" autocomplete="organization"></label>'
    + '<div class="pair"><label>Your name<input name="name" autocomplete="name"></label>'
    + '<label>Your role<select name="role"><option>Otolaryngologist</option><option>Audiologist</option><option>Practice administrator</option><option>Other</option></select></label></div>'
    + '<div class="pair"><label>Email<input name="email" type="email" autocomplete="email"></label><label>Phone<input name="phone" type="tel" autocomplete="tel"></label></div>'
    + '<div class="pair"><label>Main city you serve<input name="city" autocomplete="address-level2"></label><label>Number of ENT providers<select name="providers"><option>1</option><option>2 to 3</option><option>4 to 6</option><option>7 or more</option></select></label></div>'
    + '<label>Clinics that already refer to you (optional)<textarea name="clinics" placeholder="Pediatric and urgent care clinics you work with most"></textarea></label>'
    + '<label class="agree"><input type="checkbox" name="agree"> <span>I agree to share my information with the Compassio coalition (Compassio Medical Education, E3 and MAICO).</span></label>'
    + '<p class="fine" style="margin:0">By submitting, you agree that your information will be shared with the Compassio coalition, which is Compassio Medical Education, E3 (the US distributor) and MAICO (the manufacturer), so they can contact you about the program. Each of them may contact you by phone, text or email. Your information is not sold to anyone else.</p>'
    + '<p class="err" hidden></p><button type="submit" class="btn primary big">' + btn + '</button></form>';
  var f = box.querySelector('form'), err = box.querySelector('.err');
  var fail = function (m) { err.textContent = m; err.hidden = false; };
  f.onsubmit = function (e) {
    e.preventDefault(); err.hidden = true;
    if (!f.organization.value.trim()) return fail('Add your practice name.');
    if (!f.name.value.trim()) return fail('Add your name.');
    if (!f.email.value.trim() && !f.phone.value.trim()) return fail('Add an email or phone number so we can reach you.');
    if (!f.agree.checked) return fail('Please tick the box to agree to how your information is shared.');
    var first = f.name.value.trim().split(' ')[0];
    box.innerHTML = '<div class="done"><b>Thanks, ' + first.replace(/[<>&"]/g, '') + '.</b> Dr. LaCour’s team will reach out within one business day to check that your area is open and set up a 15-minute call. (Mockup: nothing was sent.)</div>';
  };
})();
