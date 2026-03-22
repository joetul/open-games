/**
 * Shared modal handler — close buttons, Escape, backdrop click, focus trapping.
 *
 * Dispatches a 'modal-closed' CustomEvent on the overlay when any close path fires.
 * Games can listen: overlay.addEventListener('modal-closed', handler)
 */
document.addEventListener('DOMContentLoaded', () => {
  let previousFocus = null;

  function closeModal(overlay) {
    overlay.classList.remove('active');
    overlay.dispatchEvent(new CustomEvent('modal-closed'));
    if (previousFocus && previousFocus.focus) {
      previousFocus.focus();
      previousFocus = null;
    }
  }

  // Track focus when modals open so we can restore it on close
  const observer = new MutationObserver((mutations) => {
    for (const m of mutations) {
      if (m.attributeName !== 'class') continue;
      const overlay = m.target;
      if (overlay.classList.contains('active') && !previousFocus) {
        previousFocus = document.activeElement;
      }
    }
  });

  document.querySelectorAll('.modal-overlay').forEach(overlay => {
    observer.observe(overlay, { attributes: true, attributeFilter: ['class'] });
  });

  // Close-button clicks (delegated)
  document.addEventListener('click', (e) => {
    const closeBtn = e.target.closest('.modal-close');
    if (closeBtn) {
      const overlay = closeBtn.closest('.modal-overlay');
      if (overlay) closeModal(overlay);
    }
  });

  // Escape key — close the topmost active modal
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const active = document.querySelector('.modal-overlay.active');
    if (active) {
      e.preventDefault();
      e.stopImmediatePropagation();
      closeModal(active);
    }
  });

  // Backdrop click — close if click is on the overlay itself (not the inner modal)
  document.querySelectorAll('.modal-overlay').forEach(overlay => {
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) {
        closeModal(overlay);
      }
    });
  });

  // Focus trap — keep focus within the active modal
  document.addEventListener('focusin', (e) => {
    const active = document.querySelector('.modal-overlay.active');
    if (!active || active.contains(e.target)) return;
    const focusable = active.querySelectorAll(
      'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
    );
    if (focusable.length) focusable[0].focus();
  });
});
