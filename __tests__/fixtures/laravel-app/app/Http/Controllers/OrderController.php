<?php

namespace App\Http\Controllers;

use App\Services\OrderService;
use Illuminate\Http\Request;

class OrderController extends Controller
{
    public function __construct(private OrderService $orders) {}

    public function approve(Request $request, int $id)
    {
        activity('orders')->log('approve');
        return response()->json($this->orders->approve($id));
    }
}
