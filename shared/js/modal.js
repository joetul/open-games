/**
 * Shared modal close-button handler — delegated click on .modal-close.
 * Include this script on every page that uses modals.
 */
document.addEventListener('DOMContentLoaded', () => {
  document.addEventListener('click', (e) => {
    const closeBtn = e.target.closest('.modal-close');
    if (closeBtn) {
      const overlay = closeBtn.closest('.modal-overlay');
      if (overlay) overlay.classList.remove('active');
    }
  });
});
