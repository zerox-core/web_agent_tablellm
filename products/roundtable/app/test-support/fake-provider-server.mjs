import http from "node:http";
import { once } from "node:events";

function sendHtml(response, html) {
  response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
  response.end(html);
}

function pageTemplate(providerId, composerHtml, sendButtonHtml, responseHtml) {
  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <title>Fake ${providerId}</title>
    <style>
      body { font: 16px sans-serif; padding: 24px; }
      [contenteditable], textarea { display: block; width: 700px; min-height: 80px; border: 1px solid #777; }
      button { margin-top: 12px; padding: 8px 16px; }
      .response { margin-top: 18px; white-space: pre-wrap; }
    </style>
  </head>
  <body data-fake-provider="${providerId}">
    ${composerHtml}
    ${sendButtonHtml}
    <div id="responses"></div>
    <script>
      const providerId = ${JSON.stringify(providerId)};
      let composer = document.querySelector('[data-fake-composer]');
      const send = document.querySelector('[data-fake-send]');
      const responseMarkup = ${JSON.stringify(responseHtml)};
      const query = new URLSearchParams(location.search);
      let sequence = 0;

      function composerText() {
        return composer instanceof HTMLTextAreaElement || composer instanceof HTMLInputElement
          ? composer.value
          : composer.innerText || composer.textContent || '';
      }

      function submit() {
        const prompt = composerText().trim();
        if (!prompt) return;
        if (query.has('captcha')) {
          const challenge = document.createElement('div');
          challenge.id = 'captcha_container';
          challenge.innerHTML = '<iframe title="验证码"></iframe>';
          document.body.append(challenge);
          return;
        }
        if (query.has('login')) {
          location.href = '/sign_in';
          return;
        }
        if (query.has('popup')) {
          window.open(location.origin + '/' + providerId + '/popup-view', '_blank');
          return;
        }
        if (query.has('thinking')) {
          sequence += 1;
          const wrapper = document.createElement('div');
          wrapper.innerHTML = responseMarkup;
          const responseNode = wrapper.firstElementChild;
          responseNode.dataset.fakeSequence = String(sequence);
          document.querySelector('#responses').append(responseNode);
          const ph = document.createElement('span');
          ph.className = 'shimmer';
          ph.textContent = '正在思考';
          responseNode.append(ph);
          const finalText = 'FAKE_RESPONSE[' + providerId + ']#' + sequence + ': ' + prompt;
          setTimeout(() => {
            ph.remove();
            responseNode.textContent = finalText;
          }, 600);
          return;
        }        sequence += 1;
        const wrapper = document.createElement('div');
        wrapper.innerHTML = responseMarkup;
        const responseNode = wrapper.firstElementChild;
        responseNode.dataset.fakeSequence = String(sequence);
        document.querySelector('#responses').append(responseNode);
        const stop = document.createElement('button');
        stop.type = 'button';
        stop.dataset.testid = 'stop-button';
        stop.setAttribute('aria-label', 'Stop generating');
        stop.className = 'fake-stop';
        document.body.append(stop);
        const finalText = 'FAKE_RESPONSE[' + providerId + ']#' + sequence + ': ' + prompt;
        const chunks = [finalText.slice(0, 12), finalText.slice(0, Math.ceil(finalText.length / 2)), finalText];
        let chunkIndex = 0;
        const timer = setInterval(() => {
          responseNode.textContent = chunks[chunkIndex];
          chunkIndex += 1;
          if (chunkIndex >= chunks.length) {
            clearInterval(timer);
            stop.remove();
          }
        }, 45);
      }

      send.addEventListener('click', submit);
      function bindComposer(node) {
        node.addEventListener('keydown', (event) => {
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            submit();
          }
        });
      }
      bindComposer(composer);
      if (new URLSearchParams(location.search).has('churn')) {
        composer.addEventListener('focus', () => {
          const replacement = composer.cloneNode(true);
          composer.replaceWith(replacement);
          composer = replacement;
          bindComposer(composer);
        }, { once: true });
      }
    </script>
  </body>
</html>`;
}

function providerPage(providerId) {
  if (providerId === "chatgpt") {
    return pageTemplate(
      providerId,
      '<div id="prompt-textarea" role="textbox" contenteditable="true" data-fake-composer></div>',
      '<button type="button" data-testid="send-button" data-fake-send>Send</button>',
      '<article class="response" data-message-author-role="assistant"></article>'
    );
  }
  if (providerId === "deepseek") {
    return pageTemplate(
      providerId,
      '<textarea data-fake-composer></textarea>',
      '<button type="submit" aria-label="发送" data-fake-send>发送</button>',
      '<div class="ds-markdown response"></div>'
    );
  }
  return pageTemplate(
    providerId,
    '<div class="semi-input-textarea" role="textbox" contenteditable="true" data-fake-composer></div>',
    '<button type="button" class="g-send-msg-btn" data-fake-send>发送</button>',
    '<div class="response" data-testid="message-assistant"></div>'
  );
}

function popupPage(providerId) {
  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <title>Fake ${providerId} popup</title>
  </head>
  <body data-fake-provider="${providerId}">
    <div id="responses"><article class="response" data-message-author-role="assistant"></article></div>
    <script>
      const providerId = ${JSON.stringify(providerId)};
      const responseNode = document.querySelector('[data-message-author-role="assistant"]');
      const finalText = 'FAKE_RESPONSE[' + providerId + ']#1: popup reply';
      const chunks = [finalText.slice(0, 10), finalText.slice(0, Math.ceil(finalText.length / 2)), finalText];
      let chunkIndex = 0;
      const stop = document.createElement('button');
      stop.type = 'button';
      stop.dataset.testid = 'stop-button';
      stop.setAttribute('aria-label', 'Stop generating');
      stop.className = 'fake-stop';
      document.body.append(stop);
      const timer = setInterval(() => {
        responseNode.textContent = chunks[chunkIndex];
        chunkIndex += 1;
        if (chunkIndex >= chunks.length) {
          clearInterval(timer);
          stop.remove();
        }
      }, 45);
    </script>
  </body>
</html>`;
}
export async function startFakeProviderServer() {
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    if (url.pathname === "/broken" || url.pathname === "/sign_in") {
      return sendHtml(response, "<!doctype html><html><body><h1>Login required</h1><button>登录</button></body></html>");
    }
    const providerId = url.pathname.replace(/^\/+/, "");    const popupRoute = /^\/(chatgpt|deepseek|doubao)\/popup-view$/.exec(url.pathname);
    if (popupRoute) return sendHtml(response, popupPage(popupRoute[1]));
    if (["chatgpt", "deepseek", "doubao"].includes(providerId)) return sendHtml(response, providerPage(providerId));
    response.writeHead(404);
    response.end("Not found");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  return {
    server,
    baseUrl: `http://127.0.0.1:${port}`,
    async close() {
      server.closeAllConnections?.();
      server.close();
      await once(server, "close");
    },
  };
}
