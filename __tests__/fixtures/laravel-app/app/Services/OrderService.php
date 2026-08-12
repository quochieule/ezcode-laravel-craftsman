<?php

namespace App\Services;

use App\Models\Order;

class OrderService
{
    public function approve(int $id): Order
    {
        $order = Order::findOrFail($id);
        if ($order->status !== 'pending') {
            throw new \DomainException('Chỉ duyệt được đơn đang pending');
        }
        $order->status = 'approved';
        $order->approved_at = now();
        $order->save();
        return $order;
    }
}
