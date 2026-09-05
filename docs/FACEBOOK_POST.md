# Bài giới thiệu Facebook

🚦 Codex làm việc dài hơi hay hết quota giữa chừng? Mình vừa nâng cấp **Codex Quota Guard MCP 1.1**.

Guard theo dõi quota sát hơn trong lúc đang làm, cảnh báo khi tốc độ tiêu hao tăng, tự yêu cầu chia nhỏ segment quá dài và nhắc lưu checkpoint trước các job nặng/GPU. Nó cũng tự làm mới dự báo khi đổi tài khoản, reset quota hoặc quay lại sau một thời gian nghỉ.

Nói ngắn gọn: **ít “đang chạy ngon thì hết quota”, nhiều “làm tiếp đúng chỗ”.** 😄

Mã nguồn mở: https://github.com/valentine-89/codex-quota-guard-mcp
