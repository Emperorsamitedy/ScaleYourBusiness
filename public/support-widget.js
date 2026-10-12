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
  var siteKey = script.getAttribute("data-site-key");
  if (!siteKey) return;
  var origin = script.getAttribute("data-origin") || new URL(script.src, location.href).origin;
  var endpoint = origin + "/api/support/public";
  var storageKey = "syb-support-token:" + siteKey;

  var css =
    ".syb-sw-launch{position:fixed;right:20px;bottom:20px;z-index:2147483000;border:0;border-radius:999px;padding:12px 18px;background:#1b1b1b;color:#fff;font:600 14px/1 system-ui,sans-serif;cursor:pointer;box-shadow:0 4px 16px rgba(0,0,0,.2)}" +
    ".syb-sw{position:fixed;right:20px;bottom:72px;z-index:2147483000;width:min(360px,calc(100vw - 40px));height:min(520px,calc(100vh - 100px));display:none;flex-direction:column;background:#fff;color:#1b1b1b;border:1px solid #e3e3e3;border-radius:12px;box-shadow:0 12px 40px rgba(0,0,0,.18);font:14px/1.45 system-ui,sans-serif;overflow:hidden}" +
    ".syb-sw.open{display:flex}" +
    ".syb-sw-head{padding:12px 14px;border-bottom:1px solid #eee;background:#fafafa}" +
    ".syb-sw-head b{display:block;font-size:14px}" +
    ".syb-sw-head small{display:block;color:#666;font-size:12px;margin-top:2px}" +
    ".syb-sw-log{flex:1;overflow:auto;padding:12px 14px;display:flex;flex-direction:column;gap:8px}" +
    ".syb-sw-msg{max-width:88%;padding:8px 11px;border-radius:10px;white-space:pre-wrap;word-wrap:break-word}" +
    ".syb-sw-msg.assistant{align-self:flex-start;background:#f2f2f2}" +
    ".syb-sw-msg.customer{align-self:flex-end;background:#1b1b1b;color:#fff}" +
    ".syb-sw-msg.note{align-self:center;background:transparent;color:#666;font-size:12px}" +
    ".syb-sw-form{display:flex;gap:8px;padding:10px;border-top:1px solid #eee}" +
    ".syb-sw-form input{flex:1;padding:10px 12px;border:1px solid #ddd;border-radius:8px;font:inherit}" +
    ".syb-sw-form button{padding:10px 14px;border:0;border-radius:8px;background:#1b1b1b;color:#fff;font:inherit;cursor:pointer}" +
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
    '<div class="syb-sw-head"><b>Automated assistant</b><small>Not a person. Ask for a human any time.</small></div>' +
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
        if (json.business_name) head.textContent = json.business_name + " · automated assistant";
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
