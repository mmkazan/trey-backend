// Inbound WhatsApp auto-reply.
//
// Set this function's URL as the "A message comes in" webhook on the Trey
// WhatsApp sender in Twilio. When anyone messages the Trey number, Twilio
// calls this and we reply with support contact details — because the number
// itself only sends automated review-approval alerts and isn't monitored.
//
// The reply is a normal freeform message (allowed, since the person's inbound
// message opens a 24-hour session window), so no template or approval is needed.
//
// Optional future add-ons: forward the inbound text to the owner's real number,
// or skip the auto-reply for known approval-flow replies.

exports.handler = async () => {
  const reply =
    "Thanks for messaging Trey. This number sends your review-approval alerts and isn't monitored for replies. " +
    "For any help, please call or message us on +44 7941 052034, or email mmkazan@gmail.com and we'll get straight back to you.";

  const twiml =
    '<?xml version="1.0" encoding="UTF-8"?>' +
    "<Response><Message>" + reply + "</Message></Response>";

  return {
    statusCode: 200,
    headers: { "Content-Type": "text/xml" },
    body: twiml,
  };
};
