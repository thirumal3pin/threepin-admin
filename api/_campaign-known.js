// The text of the templates 3 PIN made in TailorTalk before the Campaigns screen existed, as Meta
// holds them (read on 4 Nov 2026). TailorTalk's API gives a template's name and status but never
// its text, and the screen needs the text to show the message and fill its variables. A template
// described in the screen (campaignTemplates/…) takes precedence; new templates made in TailorTalk
// are described there once, so this list never has to grow.
export const KNOWN_TEMPLATES = {
  post_visit_feedback: {
    header: 'Site Visit Feedback',
    body: 'Hi {{name}}! 😊\n\nThank you for visiting *{{property_name}}* ({{property_code}}) with us today.\n\nWe\'d love to hear about your experience! Please feel free to share your *feedback* — what you liked, any concerns, or questions you still have.\n\nWe are always happy to assist you further.',
    footer: '- 3PIN Realty', buttons: ['Share Feedback', 'Request a Call'], purpose: 'visit_feedback',
    // Its words say "with us today" (as Meta approved them — not to be edited here): sent on any
    // other day than the visit it reads wrong, so the page warns.
    saySameDay: true
  },
  property_requirement_followup: {
    header: 'Property Requirement Follow-Up',
    body: 'Hi {{customer_name}}! 😊 AIRA here from 3 PIN Realty, just checking in.\n\nWe would love to help you find the right property in Chennai. Are you looking to *buy*, *rent*, or *sell* a property?',
    footer: '', buttons: ['Buy Property', 'Rent Property', 'Sell or List Property'], purpose: 'followup'
  },
  sold_out_collect_requirement: {
    header: 'Property Update',
    body: 'Hi {{name}}, thank you for your interest! 🙏\n\nUnfortunately, *{{property_name}}* has just been *SOLD*.\n\nBut don\'t worry — we have several similar options across Chennai! Share your requirement and we\'ll send matching properties on priority:\n\n1️⃣ Preferred Area\n2️⃣ Budget Range\n3️⃣ Size / BHK / Preferences\n\nWhich area in Chennai are you primarily looking at? 🏠',
    footer: '- 3PIN Realty', buttons: ['show similar properties'], purpose: 'sold_out', relabelled: 'Meta moved it from Utility to Marketing'
  },
  site_visit_unavailable_update: {
    header: 'Site Visit Update',
    body: 'Hello {{name}}, thank you for reaching out to 3 PIN Realty. We regret to inform you that this property is currently not ready for a site visit. We will notify you as soon as visits open up. Thank you for your patience and understanding!',
    footer: '- 3PIN Realty', buttons: [], purpose: 'visit_unavailable'
  }
};
