# Raw HTML fixture

Raw HTML in markdown must be treated as data, not executed.

Inline image with handler: <img src=x onerror=alert(1)>

Inline handler: <a href="#" onclick="alert(1)">click</a>

Inline frame: <iframe src="https://example.com"></iframe>

Script tag: <script>alert(1)</script>

Plain text continues as data.
