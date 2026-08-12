<!DOCTYPE html>
<html>
<head>
    <meta name="csrf-token" content="{{ csrf_token() }}">
    <title>@yield('title')</title>
    @stack('scripts')
</head>
<body>
    <div id="app">
        @yield('content')
    </div>
    <script src="{{ asset('js/jquery.min.js') }}"></script>
    <script src="{{ asset('js/admin/orders.js') }}"></script>
    @stack('scripts-bottom')
</body>
</html>
