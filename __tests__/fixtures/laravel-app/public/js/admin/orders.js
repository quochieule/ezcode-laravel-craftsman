/* eslint-disable */
/* Fixture — orders.js: jQuery + AJAX cho trang admin orders */
$(document).ready(function () {
  $.ajaxSetup({
    headers: { 'X-CSRF-TOKEN': $('meta[name="csrf-token"]').attr('content') },
  });

  // Duyệt nhanh từ trang list (delegated — phần tử render động)
  $(document).on('click', '.quick-approve-btn', function () {
    var id = $(this).data('id');
    $.post('/admin/orders/' + id + '/approve', function (res) {
      toastr.success('Đã duyệt #' + id);
    });
  });

  // Form xóa
  $('#delete-order-form').on('submit', function (e) {
    e.preventDefault();
    if (!confirm('Xóa đơn?')) return;
    this.submit();
  });

  // URL hardcoded không có route (cố tình — để test broken link)
  $.get('/admin/reports/export-csv', function () {});
});

function refreshOrderList() {
  window.location.reload();
}
