<?php

namespace App\Http\Requests;

use Illuminate\Foundation\Http\FormRequest;

class OrderRequest extends FormRequest
{
    public function rules(): array
    {
        return [
            'order_number' => ['required', 'string', 'max:50'],
            'total' => ['required', 'numeric', 'min:0'],
        ];
    }
}
