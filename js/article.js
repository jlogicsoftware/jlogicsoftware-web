// Renders /articles/<slug> by fetching /articles/<slug>.md and converting it with marked.

import { marked } from './vendor/marked.esm.js';

const body = document.getElementById('article-body');
const slug = location.pathname.replace(/\/+$/, '').split('/').pop();

const fail = (message) => {
  body.innerHTML = `<p class="article__status">${message}</p>`;
  body.removeAttribute('aria-busy');
};

const render = async () => {
  if (!/^[a-z0-9-]+$/.test(slug)) return fail('Article not found.');

  let response;
  try {
    response = await fetch(`/articles/${slug}.md`);
  } catch {
    return fail('Could not load the article. Check your connection and reload.');
  }
  if (!response.ok) return fail('Article not found.');

  body.innerHTML = marked.parse(await response.text());
  body.removeAttribute('aria-busy');

  for (const link of body.querySelectorAll('a[href^="http"]')) {
    if (new URL(link.href).origin !== location.origin) {
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
    }
  }

  const title = body.querySelector('h1')?.textContent;
  if (title) document.title = `${title} | jLogic Software`;
};

render();
