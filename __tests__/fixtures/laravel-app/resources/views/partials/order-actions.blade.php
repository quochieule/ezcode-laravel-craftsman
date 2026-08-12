@if ($order->status === 'pending')
    <button type="button" class="btn btn-primary" id="approve-order-btn">Duyệt đơn</button>
@endif
<a href="{{ route('orders.index') }}" class="btn btn-secondary">Quay lại</a>
<form action="{{ route('orders.destroy', $order->id) }}" method="POST" id="delete-order-form">
    @csrf
    @method('DELETE')
    <button type="submit" class="btn btn-danger">Xóa</button>
</form>
