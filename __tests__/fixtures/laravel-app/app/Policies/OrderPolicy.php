<?php

namespace App\Policies;

use App\Models\Order;
use App\Models\User;

class OrderPolicy
{
    public function approve(User $user, Order $order): bool
    {
        return $user->is_admin;
    }
}
