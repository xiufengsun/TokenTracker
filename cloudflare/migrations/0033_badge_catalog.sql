INSERT INTO tokentracker_badge_catalog(badge_id,sort_order,lower_is_better,bronze,silver,gold,diamond) VALUES
 ('token_titan',1,0,100000000,1000000000,10000000000,100000000000),
 ('big_day',2,0,10000000,100000000,500000000,3000000000),
 ('wordsmith',3,0,5000000,25000000,100000000,300000000),
 ('marathoner',4,0,7,30,100,365),('streak',5,0,3,7,30,100),('weekend_warrior',6,0,5,20,50,100),
 ('momentum',7,0,2,6,15,40),('polyglot',8,0,5,15,30,60),('trendsetter',9,0,2,5,10,20),('multitool',10,0,2,4,6,10),
 ('podium',11,1,100,30,10,3),('veteran',12,0,30,90,180,365)
 ON CONFLICT(badge_id) DO NOTHING;
CREATE UNIQUE INDEX IF NOT EXISTS badge_bronze_number ON tokentracker_user_badges(badge_id,bronze_no) WHERE bronze_no IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS badge_silver_number ON tokentracker_user_badges(badge_id,silver_no) WHERE silver_no IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS badge_gold_number ON tokentracker_user_badges(badge_id,gold_no) WHERE gold_no IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS badge_diamond_number ON tokentracker_user_badges(badge_id,diamond_no) WHERE diamond_no IS NOT NULL;
