<?php

test('admin can approve pending order', function () {
    $this->withoutMiddleware();
    $response = $this->postJson('/admin/orders/1/approve');
    $response->assertOk();
});
