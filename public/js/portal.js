/* ============================================================
   AICTE FDR Portal — Client-side JS
   Minimal vanilla JS only. No jQuery.
   ============================================================ */

'use strict';

// ---- Auto-dismiss flash messages after 5 seconds ----
document.addEventListener('DOMContentLoaded', function () {
  const alerts = document.querySelectorAll('.alert-auto-dismiss');
  alerts.forEach(function (el) {
    setTimeout(function () {
      const bsAlert = bootstrap.Alert.getOrCreateInstance(el);
      if (bsAlert) bsAlert.close();
    }, 5000);
  });
});

// ---- Client-side form validation (Bootstrap 5 style) ----
document.addEventListener('DOMContentLoaded', function () {
  const forms = document.querySelectorAll('form.needs-validation');
  forms.forEach(function (form) {
    form.addEventListener('submit', function (event) {
      if (!form.checkValidity()) {
        event.preventDefault();
        event.stopPropagation();
      }
      form.classList.add('was-validated');
    }, false);
  });
});

// ---- Amount formatter: format input as currency on blur ----
document.addEventListener('DOMContentLoaded', function () {
  const amountInputs = document.querySelectorAll('input[data-format="amount"]');
  amountInputs.forEach(function (input) {
    input.addEventListener('blur', function () {
      const val = parseFloat(input.value);
      if (!isNaN(val) && val >= 0) {
        input.value = val.toFixed(2);
      }
    });
  });
});

// ---- Date: ensure maturity >= issue date on FDR form ----
document.addEventListener('DOMContentLoaded', function () {
  const issueInput    = document.getElementById('issue_date');
  const maturityInput = document.getElementById('maturity_date');

  if (issueInput && maturityInput) {
    function validateDates() {
      if (issueInput.value && maturityInput.value) {
        if (maturityInput.value <= issueInput.value) {
          maturityInput.setCustomValidity('Maturity date must be after the issue date.');
        } else {
          maturityInput.setCustomValidity('');
        }
      }
    }
    issueInput.addEventListener('change', validateDates);
    maturityInput.addEventListener('change', validateDates);
  }
});

// ---- Confirm dangerous actions (release reject, waive discrepancy) ----
document.addEventListener('DOMContentLoaded', function () {
  const confirmBtns = document.querySelectorAll('[data-confirm]');
  confirmBtns.forEach(function (btn) {
    btn.addEventListener('click', function (e) {
      const msg = btn.getAttribute('data-confirm');
      if (!window.confirm(msg)) {
        e.preventDefault();
        e.stopPropagation();
      }
    });
  });
});

// ---- Toggle filter panel ----
document.addEventListener('DOMContentLoaded', function () {
  const toggleBtn = document.getElementById('toggleFilters');
  const filterPanel = document.getElementById('filterPanel');
  if (toggleBtn && filterPanel) {
    toggleBtn.addEventListener('click', function () {
      filterPanel.classList.toggle('d-none');
      const isHidden = filterPanel.classList.contains('d-none');
      toggleBtn.innerHTML = isHidden
        ? '<i class="bi bi-funnel"></i> Show Filters'
        : '<i class="bi bi-funnel-fill"></i> Hide Filters';
    });
  }
});

// ---- CSV export: trigger download from table ----
window.exportTableToCSV = function (tableId, filename) {
  const table = document.getElementById(tableId);
  if (!table) return;

  const rows = Array.from(table.querySelectorAll('tr'));
  const csv = rows.map(function (row) {
    return Array.from(row.querySelectorAll('th, td'))
      .map(function (cell) {
        let text = cell.innerText.replace(/"/g, '""').replace(/\n/g, ' ');
        return '"' + text + '"';
      })
      .join(',');
  }).join('\n');

  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = filename || 'export.csv';
  link.click();
};
