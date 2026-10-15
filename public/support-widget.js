/* The embeddable support widget — Phase 4 Session B (P4-07).
 *
 * One <script> tag on the owner's own site:
 *   <script src="https://<app>/support-widget.js" data-site-key="…" async></script>
 *
 * It talks only to /api/support/public with the site key and a
 * conversation token it keeps in sessionStorage — never a cookie, never
 * the owner's app session. The first line a visitor reads is the
 * disclosure (rule 20): this is an automated assistant, and a human is
 * one message away. Plain script, no framework, so it drops into any
 * page the owner has.
 */
(function () {
  "use strict";
  var script = document.currentScript;
  if (!script) return;
  // One assistant per page, however many times the tag runs (pasted twice,
  // or a framework re-inserting it): a second launcher would be a second
  // conversation the visitor can't tell apart.
  if (document.querySelector(".syb-sw-launch")) return;
  var siteKey = script.getAttribute("data-site-key");
  if (!siteKey) return;
  var origin = script.getAttribute("data-origin") || new URL(script.src, location.href).origin;
  var endpoint = origin + "/api/support/public";
  var storageKey = "syb-support-token:" + siteKey;

  // The app's Ember language, self-contained: the owner's site has none of
  // the app's fonts or tokens, so every value is inline and every font
  // falls back to the visitor's own system faces.
  var css =
    ".syb-sw-launch,.syb-sw,.syb-sw *{box-sizing:border-box}" +
    ".syb-sw-launch{position:fixed;right:20px;bottom:20px;z-index:2147483000;display:inline-flex;align-items:center;gap:9px;" +
    "padding:12px 18px 12px 15px;border:1px solid transparent;border-radius:999px;cursor:pointer;color:#f2f3f5;" +
    "font:600 14px/1 'Satoshi','Geist',ui-sans-serif,system-ui,-apple-system,'Segoe UI',sans-serif;letter-spacing:.01em;" +
    "background:linear-gradient(#131418,#131418) padding-box,linear-gradient(135deg,rgba(225,86,15,.75),rgba(255,255,255,.1) 45%,rgba(76,125,240,.55)) border-box;" +
    "box-shadow:0 10px 30px rgba(0,0,0,.35);transition:transform .24s cubic-bezier(.2,.7,.3,1)}" +
    ".syb-sw-launch:hover{transform:translateY(-1px)}" +
    ".syb-sw-launch:focus-visible{outline:2px solid #f59b4b;outline-offset:3px}" +
    ".syb-sw-launch::before{content:'';width:8px;height:8px;border-radius:2px;background:#f59b4b;box-shadow:0 0 10px rgba(245,155,75,.7)}" +
    ".syb-sw{position:fixed;right:20px;bottom:76px;z-index:2147483000;width:min(372px,calc(100vw - 40px));height:min(540px,calc(100vh - 110px));" +
    "display:none;flex-direction:column;overflow:hidden;color:#f2f3f5;border:1px solid transparent;border-radius:22px;" +
    "font:14px/1.5 'Geist',ui-sans-serif,system-ui,-apple-system,'Segoe UI',sans-serif;" +
    "background:linear-gradient(rgba(19,20,24,.97),rgba(19,20,24,.97)) padding-box,linear-gradient(135deg,rgba(225,86,15,.65),rgba(255,255,255,.09) 42%,rgba(255,255,255,.07) 62%,rgba(76,125,240,.45)) border-box;" +
    "box-shadow:0 24px 60px rgba(0,0,0,.45);backdrop-filter:blur(18px) saturate(1.25);-webkit-backdrop-filter:blur(18px) saturate(1.25)}" +
    ".syb-sw.open{display:flex;animation:syb-sw-rise .32s cubic-bezier(.2,.7,.3,1) both}" +
    "@keyframes syb-sw-rise{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}" +
    "@media (prefers-reduced-motion:reduce){.syb-sw.open{animation:none}.syb-sw-launch{transition:none}}" +
    ".syb-sw-head{padding:18px 20px 14px;border-bottom:1px solid rgba(255,255,255,.07)}" +
    ".syb-sw-eyebrow{display:block;font:500 10.5px/1 ui-monospace,'Geist Mono','SFMono-Regular',Menlo,Consolas,monospace;letter-spacing:.14em;text-transform:uppercase;color:#f59b4b;margin-bottom:9px}" +
    ".syb-sw-head b{display:block;font:700 17px/1.25 'Satoshi','Geist',ui-sans-serif,system-ui,sans-serif;letter-spacing:-.01em;color:#f2f3f5}" +
    ".syb-sw-head small{display:block;color:#9ba1ab;font-size:12.5px;margin-top:4px}" +
    ".syb-sw-log{flex:1;overflow:auto;padding:16px 16px 8px;display:flex;flex-direction:column;gap:10px;scrollbar-width:thin;scrollbar-color:rgba(255,255,255,.12) transparent}" +
    ".syb-sw-msg{max-width:86%;padding:10px 13px;border-radius:14px;white-space:pre-wrap;word-wrap:break-word;font-size:14px;line-height:1.5}" +
    ".syb-sw-msg.assistant{align-self:flex-start;background:#1a1c21;border:1px solid rgba(255,255,255,.12);border-bottom-left-radius:5px}" +
    ".syb-sw-msg.customer{align-self:flex-end;background:#f59b4b;color:#1c1006;border-bottom-right-radius:5px}" +
    ".syb-sw-msg.note{align-self:center;display:inline-flex;align-items:center;gap:7px;background:transparent;color:#9ba1ab;font-size:12px;padding:4px 6px}" +
    ".syb-sw-msg.note::before{content:'';width:6px;height:6px;border-radius:50%;background:#34d399;flex:none}" +
    ".syb-sw-form{display:flex;gap:8px;padding:12px 14px 14px;border-top:1px solid rgba(255,255,255,.07)}" +
    ".syb-sw-form input{flex:1;min-width:0;padding:11px 14px;color:#f2f3f5;background:rgba(26,28,33,.72);border:1px solid rgba(255,255,255,.07);border-radius:12px;font:inherit;outline:none;" +
    "transition:border-color .24s cubic-bezier(.2,.7,.3,1),box-shadow .24s cubic-bezier(.2,.7,.3,1)}" +
    ".syb-sw-form input::placeholder{color:#9ba1ab}" +
    ".syb-sw-form input:focus{border-color:#f59b4b;box-shadow:0 0 0 3px rgba(245,155,75,.22)}" +
    ".syb-sw-form button{padding:0 18px;min-height:42px;border:0;border-radius:999px;background:#f59b4b;color:#1c1006;font-family:inherit;font-size:14px;font-weight:600;line-height:1;letter-spacing:.02em;cursor:pointer;transition:background .24s}" +
    ".syb-sw-form button:hover{background:#ffb25c}" +
    ".syb-sw-form button:focus-visible{outline:2px solid #f59b4b;outline-offset:2px}" +
    ".syb-sw-form button:disabled{opacity:.5;cursor:default}";
  var style = document.createElement("style");
  style.textContent = css;
  document.head.appendChild(style);

  var launch = document.createElement("button");
  launch.className = "syb-sw-launch";
  launch.type = "button";
  launch.textContent = "Ask a question";
  launch.setAttribute("aria-label", "Open the automated assistant");

  var panel = document.createElement("div");
  panel.className = "syb-sw";
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-label", "Automated assistant");
  panel.innerHTML =
    '<div class="syb-sw-head"><span class="syb-sw-eyebrow">Automated assistant</span><b>Ask a question</b><small>Not a person. Ask for a human any time.</small></div>' +
    '<div class="syb-sw-log" aria-live="polite"></div>' +
    '<form class="syb-sw-form"><input type="text" maxlength="1000" placeholder="Type your question" aria-label="Your message" required><button type="submit">Send</button></form>';
  document.body.appendChild(launch);
  document.body.appendChild(panel);

  var head = panel.querySelector(".syb-sw-head b");
  var log = panel.querySelector(".syb-sw-log");
  var form = panel.querySelector("form");
  var input = form.querySelector("input");
  var send = form.querySelector("button");
  var token = null;
  var started = false;

  function add(role, text) {
    var el = document.createElement("div");
    el.className = "syb-sw-msg " + role;
    el.textContent = text;
    log.appendChild(el);
    log.scrollTop = log.scrollHeight;
  }

  function post(body) {
    return fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      credentials: "omit",
    }).then(function (res) {
      return res.json().then(function (json) {
        if (!res.ok) throw new Error(json.error || "something went wrong");
        return json;
      });
    });
  }

  function start() {
    if (started) return Promise.resolve();
    started = true;
    var saved = null;
    try {
      saved = sessionStorage.getItem(storageKey);
    } catch (e) {
      saved = null;
    }
    if (saved) {
      token = saved;
      return post({ action: "transcript", token: token })
        .then(function (json) {
          json.messages.forEach(function (m) {
            add(m.role, m.text);
          });
        })
        .catch(function () {
          token = null;
          started = false;
          try {
            sessionStorage.removeItem(storageKey);
          } catch (e) {
            /* ignore */
          }
          return start();
        });
    }
    return post({ action: "start", site_key: siteKey })
      .then(function (json) {
        token = json.token;
        try {
          sessionStorage.setItem(storageKey, token);
        } catch (e) {
          /* private mode: the conversation lives for this page view only */
        }
        if (json.business_name) head.textContent = json.business_name;
        add("assistant", json.message.text);
      })
      .catch(function (err) {
        started = false;
        add("note", "The assistant isn't available right now. " + err.message);
      });
  }

  launch.addEventListener("click", function () {
    var open = panel.classList.toggle("open");
    launch.textContent = open ? "Close" : "Ask a question";
    if (open) {
      start().then(function () {
        input.focus();
      });
    }
  });

  form.addEventListener("submit", function (ev) {
    ev.preventDefault();
    var text = input.value.trim();
    if (!text || !token) return;
    add("customer", text);
    input.value = "";
    send.disabled = true;
    post({ action: "message", token: token, text: text })
      .then(function (json) {
        add("assistant", json.reply.text);
        if (json.escalated) add("note", "A person has been asked to pick this up.");
      })
      .catch(function (err) {
        add("note", err.message);
      })
      .then(function () {
        send.disabled = false;
        input.focus();
      });
  });
})();
