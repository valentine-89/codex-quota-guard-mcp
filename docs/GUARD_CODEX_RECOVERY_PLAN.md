# Kế hoạch khôi phục Guard trong Codex

Ngày lập: 2026-09-04. Cập nhật: 2026-09-05. Trạng thái: đã triển khai code và smoke độc lập; chờ nghiệm thu agent sử dụng trên một thread Desktop mới sau deploy.

## Kết quả triển khai

- Đã xác nhận lại đúng binary Desktop `0.153.0`; feature `mcp_2026_07_28` vẫn `under development / false`.
- Connector đã khôi phục luồng ổn định `initialize` / `notifications/initialized` / `tools/list` / `tools/call`, đồng thời giữ đường nội bộ `2026-07-28` và một core quota dùng chung.
- Discovery không đọc quota, không bind scheduler và không tạo live-client lease. Binding và lease chỉ bắt đầu khi gọi capability.
- Chẩn đoán connector được chia theo `settings`, `core_startup`, `health`, `handshake`, `forwarding`; chỉ ghi stderr với mã đã giới hạn.
- Smoke stable nhận đủ 8 tool, instructions và gọi `quota_status` thành công. Test hồi quy cũng giữ đường modern nội bộ.
- Phương án A đủ để khôi phục khả năng kết nối trong smoke; chưa sửa server instructions và chưa thêm block AGENTS.
- `npm run check` xanh 100/100 test trên PowerShell 7 / Node Windows. Nghiệm thu Desktop gồm tool catalog và tool call cùng thread vẫn phải thực hiện sau deploy.

## 1. Bằng chứng và nguyên nhân

- Commit `cd9b3fd` chuyển Guard sang MCP `2026-07-28` exclusively và bỏ handshake `initialize`.
- Binary Codex Desktop được kiểm tra là `0.153.0`; cờ `mcp_2026_07_28` hiển thị `under development / false`. CLI trên PATH là `0.147.0`, không được nhầm với binary Desktop.
- Log Desktop lặp lại `omitting pending optional MCP server` rồi `omitting MCP server without an exact ready client`, với `server_name=codex_quota_guard`, ở nhiều task mới.
- Smoke/acceptance dùng SDK v2 và ép giao thức `2026-07-28`. Kết quả xanh chỉ chứng minh server tương thích với client thử đó, không chứng minh Desktop đã nạp Guard.
- `AGENTS.md` toàn cục không có hướng dẫn Guard; installer chỉ đăng ký MCP. Thiếu hướng dẫn là vấn đề kích hoạt sử dụng riêng, không giải thích được handshake thất bại.
- Có log `quota-guard: connector requires an authenticated loopback HTTP core`. Đây là thông báo catch-all; chưa đủ bằng chứng kết luận nguyên nhân cụ thể của lần startup đó.

Lệch giao thức là vấn đề tương thích đã xác định; cần tái hiện bằng client Desktop trước/sau sửa để chốt quan hệ nhân quả. Không tiếp tục giả định chỉ restart app là đủ.

## 2. Quyết định đã chốt

- Khôi phục đầu STDIO theo giao thức ổn định mà Codex mặc định hỗ trợ; giữ core nội bộ hiện tại.
- Không tự bật tính năng MCP thử nghiệm toàn app.
- Giữ MCP optional: báo không khả dụng và cho phép tiếp tục, không đặt `required=true`.
- Thử từng phương án hướng dẫn, chỉ can thiệp AGENTS nếu chứng minh cần thiết.
- Không thay đổi quota policy, TTL, giới hạn refresh, prompt automation tiếng Anh hoặc thêm polling nền.
- Không tự restart Codex, dừng task khác, thay đổi Wi-Fi hay yêu cầu elevation.

## 3. Sửa kết nối và chẩn đoán

1. Tái hiện handshake bằng đúng binary Desktop, ghi phiên bản và cấu hình feature có hiệu lực; không dùng CLI trên PATH làm đại diện.
2. Khôi phục handshake STDIO ổn định: `initialize`, thông báo initialized, discovery/tool listing và tool calls. Cô lập chuyển đổi giao thức tại connector; giữ core hiện tại, không nhân đôi logic quota/checkpoint/automation.
3. Giữ nguyên tên và schema của 8 tool, cùng server instructions.
4. Không thay đổi cấu hình MCP khác hoặc thời gian startup grace toàn cục.
5. Tách mã lỗi theo giai đoạn: settings, core startup, health, handshake, forwarding. Chỉ ghi stderr; không ghi token, nội dung công việc hoặc bí mật. STDOUT chỉ chứa JSON-RPC.
6. Discovery không đọc quota hoặc chờ scheduler binding. Binding thực hiện khi cần capability tương ứng. Giữ single-flight và lifecycle on-demand.

Tài liệu chính thức về MCP optional/required và startup grace:
https://learn.chatgpt.com/docs/extend/mcp?surface=cli

## 4. Thử phương án hướng dẫn theo thứ tự

Dừng ở phương án ít can thiệp nhất đạt nghiệm thu:

### A. Chỉ sửa kết nối

- Giữ server instructions hiện có, không sửa AGENTS.
- Chạy ba phiên thử mới với yêu cầu công việc nhiều bước nhưng không nhắc Guard.
- Xác nhận tool đã được cung cấp và agent thực sự gọi Guard bằng log theo thread ID.

### B. Tối ưu server instructions

- Chỉ thực hiện nếu A đã có tool sẵn sàng nhưng agent không chủ động gọi.
- Rút gọn, làm rõ yêu cầu quota check trước công việc đáng kể và preflight trước từng phần việc lớn.
- Thử lại cùng bộ tình huống, không thêm AGENTS.

### C. Block AGENTS tối thiểu

- Chỉ thử nếu B vẫn không đạt; ban đầu dùng môi trường thử riêng.
- Block tiếng Anh ngắn: kiểm tra Guard trước công việc đáng kể, preflight trước từng phần việc lớn, báo một lần nếu Guard không khả dụng, không lặp thử vô hạn và không nhận là đang được bảo vệ.
- Chỉ đưa block vào installer nếu C đạt trong khi A/B không đạt.
- Dùng marker để cập nhật idempotent; bảo toàn nội dung khác. Uninstall chỉ xóa block do Guard quản lý.
- Không sao chép toàn bộ tài liệu vào AGENTS, không dùng memory làm cơ chế kích hoạt.

## 5. Kiểm thử và tiêu chí nghiệm thu

- Giao thức: client ổn định độc lập handshake thành công, nhận đủ 8 tools và instructions, gọi `quota_status` thành công. Không ép MCP mới như smoke hiện tại.
- Desktop thật: kiểm tra tool catalog và tool calls theo đúng thread ID. Phân biệt server chạy, Desktop nạp và agent sử dụng.
- Lifecycle: cold/warm start, nhiều connector đồng thời, đóng client, core restart, timeout; không tiến trình mồ côi hoặc lease bị treo.
- Lỗi: thiếu settings, core không khởi động, handshake không hỗ trợ; stderr rõ nguyên nhân, STDOUT sạch.
- Hành vi: ba phiên công việc nhiều bước tự gọi Guard; một câu hỏi ngắn không phát sinh kiểm tra không cần thiết. Không dùng lời tự báo của agent thay log tool call.
- Hồi quy: giữ TTL thích ứng, giới hạn đọc theo yêu cầu, single-flight, backoff, lease và prompt automation tiếng Anh.
- Defer: dùng fixture trong bước kiểm tra tải server, không tạo automation thật để chứng minh handshake.
- Đo: thời gian kết nối lạnh/ấm, số tool call, quota 5h trước/sau các phiên thử. Ghi rõ độ làm tròn và nhiễu do task khác dùng chung tài khoản; không coi chênh lệch quota là phép đo riêng chính xác nếu chạy đồng thời.
- Nếu cần tạo task thử trong app hoặc thao tác ảnh hưởng phiên đang chạy, phối hợp với người dùng trước; không tự gián đoạn công việc hiện có.

## 6. Phát hành và bàn giao

1. Chạy `npm run check` trước commit.
2. Cập nhật tài liệu về giao thức hỗ trợ và ba mức xác minh: server chạy, Desktop nạp, agent sử dụng.
3. Commit Conventional Commits. Không commit SQLite, auth material hoặc checkpoint thật.
4. Deploy lại bản cài đang đăng ký tại `D:\VSYS\codex-quota-guard-new-user-20260903`, sau khi xác minh đường dẫn còn đúng; bảo toàn state/checkpoint và cấu hình không liên quan.
5. Không suy diễn deploy thành quyền push GitHub. Không tự restart Codex; phối hợp reload khi không làm gián đoạn task khác.
6. Chạy lại nghiệm thu trên Desktop sau deploy/reload. Chỉ báo hoàn tất khi đạt kiểm tra Desktop thật; nếu mới đạt smoke độc lập, ghi rõ chưa đạt tích hợp.

## 7. Điểm bắt đầu khi tiếp tục

- Đọc lại AGENTS.md và trạng thái worktree; xác minh version/config/log hiện tại vì có thể đã thay đổi.
- Bắt đầu bằng tái hiện lỗi client thật và test hồi quy, không thêm AGENTS ngay.
- Nếu phát sinh quyết định hỗ trợ thêm phiên bản cũ hoặc thay đổi phạm vi giao thức ngoài lựa chọn trên, hỏi người dùng trước.
