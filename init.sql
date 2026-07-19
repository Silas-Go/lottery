set names utf8mb4 collate utf8mb4_unicode_ci;

create table if not exists inventory(
    id int auto_increment comment '奖品id，自增',
    name varchar(20) not null comment '奖品名称',
    description varchar(100) not null default '' comment '奖品描述',
    picture varchar(200) not null default '' comment '奖品图片',
    price int not null default 0 comment '价值',
    count int not null default 0 comment '库存量',
    primary key (id)
)default charset=utf8mb4;

insert into inventory (id,name,picture,price,count) values (1,'谢谢参与','img/face.png',0,1000);
insert into inventory (name,picture,price,count) values
('篮球','img/ball.jpeg',100,1000),
('水杯','img/cup.jpeg',80,1000),
('电脑','img/laptop.jpeg',6000,200),
('平板','img/pad.jpg',4000,300),
('手机','img/phone.jpeg',5000,400),
('锅','img/pot.jpeg',120,1000),
('茶叶','img/tea.jpeg',90,1000),
('无人机','img/uav.jpeg',400,100),
('酒','img/wine.jpeg',160,500);

create table if not exists orders(
    id int auto_increment comment '订单id，自增',
    activity_id int not null default 1 comment '活动id',
    gift_id int not null comment '商品id',
    user_id int not null comment '用户id',
    count int not null default 1 comment '购买数量',
    status varchar(32) not null default 'pending_payment' comment '订单状态: pending_payment/paid/cancelled',
    inventory_mode varchar(16) not null comment '库存模式: redis/mysql',
    stock_released tinyint(1) not null default 0 comment '取消库存是否已回补',
    expires_at datetime not null comment '支付截止时间',
    paid_at datetime null comment '支付完成时间',
    cancelled_at datetime null comment '取消时间',
    cancel_reason varchar(64) not null default '' comment '取消原因',
    create_time datetime default current_timestamp comment '订单创建时间',
    update_time datetime default current_timestamp on update current_timestamp comment '订单更新时间',
    primary key (id),
    key idx_user (user_id),
    key idx_status_expires (status, expires_at),
    unique key uk_activity_user (activity_id, user_id)
)default charset=utf8mb4;

-- 第一章《那本不该被翻烂的百职录》的只读真本。
-- 应用启动时也会 AutoMigrate + FirstOrCreate，以兼容不会重新执行 init.sql 的老数据卷。
create table if not exists profession_archives(
    id int not null,
    code varchar(64) not null,
    name varchar(64) not null,
    title varchar(128) not null,
    sigil varchar(16) not null,
    accent varchar(16) not null,
    summary varchar(600) not null,
    oath varchar(255) not null,
    primary key (id),
    unique key uk_profession_code (code)
)default charset=utf8mb4;

insert ignore into profession_archives (id,code,name,title,sigil,accent,summary,oath) values
(1,'night-warden','守夜人','替沉睡的城邦守住最后一盏灯','夜','#315c78','他们认识每一条在午夜改道的河，也听得见城墙深处极轻的裂响。守夜人的职责不是战胜黑暗，而是让所有人醒来时，仍相信黎明会如约而至。','灯不必照亮远方，只要不在我手中熄灭。'),
(2,'clockwork-smith','机巧师','让沉默的铜与铁重新学会呼吸','械','#9a6737','机巧师的工作台从不真正安静。齿轮记得手指的温度，旧钟会在无人处低声报时，而每一件被世人判定报废的器物，都可能在他们掌心获得第二次心跳。','世上没有废铁，只有尚未被听懂的请求。'),
(3,'star-reader','观星者','从群星的迟信里辨认尚未发生的风暴','星','#6659a8','他们在最高的塔上记录星辰，把几百年前启程的光译成今日的预兆。观星者并不预言命运；他们只是比旁人更早看见选择的代价。','星辰从不回答，只把问题照得更清楚。'),
(4,'raven-physician','渡鸦医师','在瘟风经过之后替名字留住体温','鸦','#48645a','渡鸦医师随黑羽穿过封闭的城门。他们携带草药、银针和一本从不公开的姓名册：治愈一人便划去一个名字，未能归来的人，则由他们亲自送回故乡。','疾病可以带走呼吸，不能带走一个人被记得的方式。');

-- 材料购买顺序实验的独立夹具，不参与秒杀 inventory、orders 或 MQ 链路。
create table if not exists purchase_lab_inventory(
    material_id int not null,
    initial_stock int not null,
    stock int not null,
    updated_at datetime not null default current_timestamp on update current_timestamp,
    primary key (material_id)
)default charset=utf8mb4;

insert ignore into purchase_lab_inventory (material_id, initial_stock, stock) values
(1,64,64),(2,48,48),(3,24,24),(4,12,12);
