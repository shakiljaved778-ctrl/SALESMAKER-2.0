/*
 * SalesMaker web form embed (§7.1). On any site:
 *
 *   <div data-sm-form="https://forms.salesmaker.app/f/acme/<form id>" data-sm-title="Contact us"></div>
 *   <script src="https://forms.salesmaker.app/forms/embed.js" async></script>
 *
 * Each placeholder becomes an iframe of the hosted form, passing on the page's UTM parameters and
 * click ids, its address (landing page) and referrer. The form reports its height so the frame
 * fits, and asks this page to follow its redirect after a submission. Messages are only accepted
 * from the form's own frame and origin.
 */
(function () {
  'use strict';
  var PASS = [
    'utm_source',
    'utm_medium',
    'utm_campaign',
    'utm_term',
    'utm_content',
    'gclid',
    'fbclid',
  ];

  function mount(el) {
    if (el.getAttribute('data-sm-mounted')) return;
    var src;
    try {
      src = new URL(el.getAttribute('data-sm-form') || '', document.baseURI);
    } catch {
      return;
    }
    if (
      !/^https?:$/.test(src.protocol) ||
      !/^\/f\/[a-z0-9-]+\/[0-9a-f-]{36}\/?$/i.test(src.pathname)
    )
      return;
    var page = new URL(window.location.href);
    page.hash = '';
    src.searchParams.set('embed', '1');
    for (var i = 0; i < PASS.length; i += 1) {
      var value = page.searchParams.get(PASS[i]);
      if (value) src.searchParams.set(PASS[i], value);
    }
    src.searchParams.set('landing', page.toString());
    if (document.referrer) src.searchParams.set('referrer', document.referrer);
    var locale = el.getAttribute('data-sm-locale');
    if (locale) src.searchParams.set('locale', locale);

    var frame = document.createElement('iframe');
    frame.src = src.toString();
    frame.title = el.getAttribute('data-sm-title') || 'Web form';
    frame.setAttribute('loading', 'lazy');
    frame.style.width = '100%';
    frame.style.border = '0';
    frame.style.minHeight = '320px';
    el.setAttribute('data-sm-mounted', '1');
    el.appendChild(frame);

    window.addEventListener('message', function (event) {
      if (event.source !== frame.contentWindow || event.origin !== src.origin) return;
      var data = event.data;
      if (!data || data.source !== 'sm-form') return;
      if (data.type === 'height' && typeof data.height === 'number' && data.height > 0)
        frame.style.height = Math.ceil(data.height) + 'px';
      if (data.type === 'redirect' && typeof data.url === 'string' && /^https:\/\//.test(data.url))
        window.location.assign(data.url);
    });
  }

  function scan() {
    var nodes = document.querySelectorAll('[data-sm-form]');
    for (var i = 0; i < nodes.length; i += 1) mount(nodes[i]);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', scan);
  else scan();
})();
