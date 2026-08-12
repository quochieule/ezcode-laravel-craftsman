@extends('layouts.app')

@section('title', 'Chi tiết đơn hàng')

@section('content')
<div class="card" id="order-card">
    <h2>Đơn #{{ $order->order_number }}</h2>
    <p>Trạng thái: <span id="order-status">{{ $order->status }}</span></p>
    <p>Tổng: {{ number_format($order->total) }}</p>
    @include('partials.order-actions', ['order' => $order])
</div>

<script>
$(document).ready(function () {
    $('#approve-order-btn').on('click', function () {
        if (!confirm('Duyệt đơn này?')) return;
        $.ajax({
            url: '{{ route("orders.approve", $order->id) }}',
            method: 'POST',
            data: { _token: $('meta[name="csrf-token"]').attr('content') },
            success: function (res) {
                $('#order-status').text(res.status);
                toastr.success('Đã duyệt đơn');
            },
            error: function (xhr) {
                toastr.error('Duyệt thất bại: ' + xhr.responseJSON.message);
            }
        });
    });
});
</script>
@endsection
