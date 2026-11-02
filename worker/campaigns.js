// Shared public campaign labels, used in the same link for everyone.
// Add only broad marketing categories here, never email addresses, names,
// recipient IDs, unique tokens or values generated per person/request.
// Examples (copy the same complete URL into a public post/newsletter):
// https://jlogicsoftware.com/about?utm_source=facebook&utm_medium=social&utm_campaign=mentoring
// https://jlogicsoftware.com/about?utm_source=linkedin&utm_medium=paid_social&utm_campaign=interview-prep
// https://jlogicsoftware.com/about?utm_source=newsletter&utm_medium=email&utm_campaign=middle-to-senior
// Unlisted values and utm_content/utm_term/click IDs are never stored.
export const CAMPAIGN_LABELS = Object.freeze({
  source: Object.freeze(['facebook', 'linkedin', 'newsletter']),
  medium: Object.freeze(['social', 'paid_social', 'email']),
  campaign: Object.freeze(['mentoring', 'interview-prep', 'middle-to-senior']),
});
