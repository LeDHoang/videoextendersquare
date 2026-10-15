/* Full-page navigation (drops all in-memory client state). Its own module so
   tests can replace it — jsdom cannot navigate. */
export function hardRedirect(url) {
  window.location.replace(url);
}
