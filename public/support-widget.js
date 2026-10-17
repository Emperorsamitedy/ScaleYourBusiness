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

  // The app's sheet language (specs/ux-spec-v1.md §2), self-contained:
  // the owner's site has none of the app's fonts or tokens, so every
  // value is inline and every face falls back to the visitor's own
  // system fonts — the widget never fetches a font from a third party.
  // Paper on an ink edge, square corners, no shadow: a 1px ink border
  // separates it from whatever page it sits on.
  var INK = "#0e1a13",
    INK2 = "#3a4c42",
    PAPER = "#f2f7f4",
    INSET = "#dfe9e3",
    RULE = "#71897d",
    OK = "#145530",
    PROSE = "'Archivo',Arial,ui-sans-serif,system-ui,sans-serif",
    MONO = "'IBM Plex Mono',ui-monospace,'SFMono-Regular',Menlo,Consolas,monospace";
  var css =
    ".syb-sw-launch,.syb-sw,.syb-sw *{box-sizing:border-box;border-radius:0}" +
    ".syb-sw-launch{position:fixed;right:20px;bottom:20px;z-index:2147483000;display:inline-flex;align-items:center;gap:8px;" +
    "min-height:48px;padding:0 18px;border:1px solid " +
    PAPER +
    ";cursor:pointer;color:" +
    PAPER +
    ";background:" +
    INK +
    ";" +
    "font:600 12.5px/1 " +
    MONO +
    ";letter-spacing:.06em;text-transform:uppercase;" +
    "transition:background-color .1s linear,color .1s linear}" +
    ".syb-sw-launch:hover,.syb-sw-launch:active{background:" +
    PAPER +
    ";color:" +
    INK +
    ";border-color:" +
    INK +
    "}" +
    ".syb-sw-launch:focus-visible{outline:2px solid " +
    INK +
    ";outline-offset:3px}" +
    ".syb-sw{position:fixed;right:20px;bottom:76px;z-index:2147483000;width:min(372px,calc(100vw - 40px));height:min(540px,calc(100vh - 110px));" +
    "display:none;flex-direction:column;overflow:hidden;color:" +
    INK +
    ";background:" +
    PAPER +
    ";border:1px solid " +
    INK +
    ";" +
    "font:14px/1.5 " +
    PROSE +
    "}" +
    ".syb-sw.open{display:flex}" +
    ".syb-sw-head{padding:16px 18px 14px;border-bottom:1px solid " +
    INK +
    "}" +
    ".syb-sw-eyebrow{display:block;font:600 11.5px/1 " +
    MONO +
    ";letter-spacing:.06em;text-transform:uppercase;color:" +
    INK2 +
    ";margin-bottom:8px}" +
    ".syb-sw-head b{display:block;font:600 16px/1.3 " +
    PROSE +
    ";color:" +
    INK +
    "}" +
    ".syb-sw-head small{display:block;color:" +
    INK2 +
    ";font-size:12.5px;margin-top:4px}" +
    ".syb-sw-log{flex:1;overflow:auto;padding:14px 16px 8px;display:flex;flex-direction:column;gap:10px;scrollbar-width:thin}" +
    ".syb-sw-msg{max-width:86%;padding:9px 12px;white-space:pre-wrap;word-wrap:break-word;font-size:14px;line-height:1.5}" +
    ".syb-sw-msg.assistant{align-self:flex-start;background:" +
    INSET +
    ";border:1px solid " +
    RULE +
    "}" +
    ".syb-sw-msg.customer{align-self:flex-end;background:" +
    INK +
    ";color:" +
    PAPER +
    "}" +
    ".syb-sw-msg.note{align-self:center;background:transparent;color:" +
    OK +
    ";font:600 11.5px/1.4 " +
    MONO +
    ";letter-spacing:.04em;text-transform:uppercase;padding:4px 6px}" +
    ".syb-sw-form{display:flex;gap:8px;padding:12px 14px 14px;border-top:1px solid " +
    INK +
    "}" +
    ".syb-sw-form input{flex:1;min-width:0;min-height:44px;padding:0 12px;color:" +
    INK +
    ";background:" +
    PAPER +
    ";border:1px solid " +
    RULE +
    ";font:inherit}" +
    ".syb-sw-form input::placeholder{color:" +
    INK2 +
    "}" +
    ".syb-sw-form input:focus{border-color:" +
    INK +
    ";outline:2px solid " +
    INK +
    ";outline-offset:1px}" +
    ".syb-sw-form button{padding:0 16px;min-height:44px;border:1px solid " +
    INK +
    ";background:" +
    INK +
    ";color:" +
    PAPER +
    ";" +
    "font:600 12.5px/1 " +
    MONO +
    ";letter-spacing:.06em;text-transform:uppercase;cursor:pointer;transition:background-color .1s linear,color .1s linear}" +
    ".syb-sw-form button:hover{background:" +
    PAPER +
    ";color:" +
    INK +
    "}" +
    ".syb-sw-form button:focus-visible{outline:2px solid " +
    INK +
    ";outline-offset:2px}" +
    ".syb-sw-form button:disabled{cursor:not-allowed;border-style:dashed;background:" +
    PAPER +
    ";color:" +
    INK2 +
    "}";
  var style = document.createElement("style");
  style.textContent = css;
  document.head.appendChild(style);

  var launch = document.createElement("button");
  launch.className = "syb-sw-launch";
  launch.type = "button";
  launch.textContent = "Ask a question →";
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
