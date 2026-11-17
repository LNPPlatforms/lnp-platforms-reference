// Public websites the platform hosts on the app's own Cloudflare Pages project. functions/_middleware.js serves a request
// for one of these domains (www. included) from sites/<folder>/. To put a new site live: add its folder under sites/,
// add a line here, then add the domain under the project's Custom domains (later the Sites panel does that through the API).
export default {
  'lnpplatforms.com': 'lnpplatforms.com',
  'cognixcrm.com': 'cognixcrm.com',
};
