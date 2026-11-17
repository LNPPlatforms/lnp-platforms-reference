// /favicon.png follows the web address's white label (see brandhost.js)
import { iconHandler } from '../brandhost.js';
export const onRequest = iconHandler('favicon_url');
