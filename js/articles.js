// Renders the article index from /articles/index.json, newest first.

import { dateElement } from './date.js';

const list = document.getElementById('article-list');

const fail = (message) => {
  list.innerHTML = `<li class="article__status">${message}</li>`;
  list.removeAttribute('aria-busy');
};

const render = async () => {
  let articles;
  try {
    const response = await fetch('/articles/index.json');
    if (!response.ok) return fail('Could not load the article list.');
    articles = await response.json();
  } catch {
    return fail('Could not load the article list.');
  }

  if (!articles.length) return fail('No articles yet.');

  // Slugs begin with an ISO date, so a descending sort is newest first.
  articles.sort((a, b) => b.slug.localeCompare(a.slug));

  list.replaceChildren(
    ...articles.map(({ slug, title, description }) => {
      const item = document.createElement('li');
      item.className = 'article-list__item';

      const link = document.createElement('a');
      link.href = `/articles/${slug}`;
      link.className = 'article-list__link';

      const heading = document.createElement('h2');
      heading.className = 'article-list__heading';
      heading.textContent = title;
      link.append(heading);

      const date = dateElement(slug);
      if (date) link.append(date);

      if (description) {
        const summary = document.createElement('p');
        summary.className = 'article-list__summary';
        summary.textContent = description;
        link.append(summary);
      }

      item.append(link);
      return item;
    })
  );
  list.removeAttribute('aria-busy');
};

render();
