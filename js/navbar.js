const navbar = document.getElementById('navbar');
const toggle = document.getElementById('navbar-toggle');
const toggleIcon = document.getElementById('navbar-toggle-icon');
const mobileMenu = document.getElementById('navbar-mobile-menu');

const onScroll = () => navbar.classList.toggle('is-scrolled', window.scrollY > 20);
window.addEventListener('scroll', onScroll);
onScroll();

const setMenuOpen = (open) => {
  mobileMenu.classList.toggle('is-open', open);
  toggle.setAttribute('aria-expanded', `${open}`);
  toggleIcon.innerHTML = open
    ? '<use href="/assets/icons.svg#icon-x"></use>'
    : '<use href="/assets/icons.svg#icon-menu"></use>';
};

toggle.addEventListener('click', () => setMenuOpen(!mobileMenu.classList.contains('is-open')));

mobileMenu.querySelectorAll('.navbar-mobile-link').forEach((link) => {
  link.addEventListener('click', () => setMenuOpen(false));
});
