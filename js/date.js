// Article slugs start with their publication date: YYYY-MM-DD-title-words.

export const slugDate = (slug) => {
  const match = slug.match(/^(\d{4})-(\d{2})-(\d{2})-/);
  if (!match) return null;
  const date = new Date(Date.UTC(match[1], match[2] - 1, match[3]));
  return {
    iso: `${match[1]}-${match[2]}-${match[3]}`,
    label: date.toLocaleDateString('en-GB', {
      day: 'numeric',
      month: 'long',
      year: 'numeric',
      timeZone: 'UTC',
    }),
  };
};

export const dateElement = (slug) => {
  const date = slugDate(slug);
  if (!date) return null;
  const el = document.createElement('time');
  el.className = 'article__date';
  el.dateTime = date.iso;
  el.textContent = date.label;
  return el;
};
