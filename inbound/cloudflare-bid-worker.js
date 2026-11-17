// Cloudflare Email Routing worker for bid intake (the free option). Every email sent to the bid address is posted,
// raw, to the bid-intake edge function. Setup: BACKLOG.md "Bids: email intake setup".
// Worker settings > Variables: BID_URL = https://stfnpzqymjlxpainmgoo.supabase.co/functions/v1/bid-intake?mode=raw
//                              BID_INBOUND_SECRET = the same long random value set as the Supabase secret (mark it encrypted)
export default {
  async email(message, env) {
    const raw = await new Response(message.raw).arrayBuffer();
    const r = await fetch(env.BID_URL, {
      method: 'POST',
      headers: { 'content-type': 'message/rfc822', 'x-bid-secret': env.BID_INBOUND_SECRET, 'x-bid-to': message.to },
      body: raw,
    });
    if (!r.ok) message.setReject('We could not take this bid right now. Please try again later.');
  },
};
