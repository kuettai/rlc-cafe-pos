import boto3, json

dynamodb = boto3.client('dynamodb', region_name='ap-southeast-5')
TABLE = 'rlc-cafe-menu'

def update_item(menu_id, updates):
    expr_parts = []
    names = {}
    values = {}
    for k, v in updates.items():
        expr_parts.append(f'#{k} = :{k}')
        names[f'#{k}'] = k
        values[f':{k}'] = v
    dynamodb.update_item(
        TableName=TABLE,
        Key={'PK': {'S': f'MENU#{menu_id}'}, 'SK': {'S': 'META'}},
        UpdateExpression='SET ' + ', '.join(expr_parts),
        ExpressionAttributeNames=names,
        ExpressionAttributeValues=values
    )
    print(f'  Updated {menu_id}')

def delete_item(menu_id):
    dynamodb.delete_item(
        TableName=TABLE,
        Key={'PK': {'S': f'MENU#{menu_id}'}, 'SK': {'S': 'META'}}
    )
    print(f'  Deleted {menu_id}')

def make_variant_groups(groups):
    """Convert variant groups to DynamoDB format"""
    result = []
    for g in groups:
        options = []
        for o in g['options']:
            options.append({'M': {
                'name': {'S': o['name']},
                'price': {'N': str(o.get('price', 0))}
            }})
        result.append({'M': {
            'group': {'S': g['group']},
            'type': {'S': g['type']},
            'options': {'L': options}
        }})
    return {'L': result}

# --- 1. Rename iced/hot-only drinks ---
print("1. Renaming iced/hot-only drinks...")

update_item('e1879fcb-63b7-4977-98bb-66ea57b92c70', {
    'name': {'S': '☕ Tonic Espresso (Iced)'}
})
update_item('e3a89674-9822-422c-990c-2d3752a6c851', {
    'name': {'S': '🍋 Citrus Black (Iced)'}
})
update_item('b3e9054a-97d2-41bb-9a49-0e06eba3a357', {
    'name': {'S': '🫖 Fruit Tea (Hot)'}
})

# --- 2. Add Iced option to Tea ---
print("2. Adding Iced option to Tea...")

tea_variant_groups = make_variant_groups([
    {'group': 'Type', 'type': 'single', 'options': [
        {'name': 'Camomile', 'price': 0},
        {'name': 'Earl Grey', 'price': 0},
        {'name': 'English Breakfast', 'price': 0},
        {'name': 'Green Tea', 'price': 0},
        {'name': 'Lady Grey', 'price': 0},
        {'name': 'Peppermint', 'price': 0},
    ]},
    {'group': 'Temperature', 'type': 'single', 'options': [
        {'name': 'Hot', 'price': 0},
        {'name': 'Iced', 'price': 1},
    ]}
])
update_item('e55c0ea0-22d1-44f2-9ed1-e27cb58ed0f2', {
    'variantGroups': tea_variant_groups,
    'variants': {'L': []}  # clear old flat variants
})

# --- 3. Convert Hot/Iced drinks to variant groups ---
print("3. Converting Hot/Iced drinks to variant groups...")

# Latte & Matcha Latte: Temperature + Milk
temp_milk_groups = make_variant_groups([
    {'group': 'Temperature', 'type': 'single', 'options': [
        {'name': 'Hot', 'price': 0},
        {'name': 'Iced', 'price': 1},
    ]},
    {'group': 'Milk', 'type': 'optional', 'options': [
        {'name': 'Oat Milk', 'price': 1},
    ]}
])

for item_id in ['latte-001', '4eb25380-2f2f-46d3-82fb-0b005408ce3f']:
    update_item(item_id, {
        'variantGroups': temp_milk_groups,
        'variants': {'L': []}
    })

# Long Black, Chai Latte, Mocha, Hot Chocolate: Temperature only
temp_only_groups = make_variant_groups([
    {'group': 'Temperature', 'type': 'single', 'options': [
        {'name': 'Hot', 'price': 0},
        {'name': 'Iced', 'price': 1},
    ]}
])

for item_id in [
    '20f5736d-f49e-4d00-952e-8481c55b7636',  # Long Black
    '87d184f1-23ff-4cc5-8448-2c3083949e4c',  # Chai Latte
    '607ab60d-76f2-46d6-a8f5-54dc777e153b',  # Mocha
    'c2c644d4-4278-4934-8dfe-79ce08403a86',  # Hot Chocolate
]:
    update_item(item_id, {
        'variantGroups': temp_only_groups,
        'variants': {'L': []}
    })

# --- 4. Group Sodas into one entry ---
print("4. Grouping sodas...")

# Delete individual sodas
soda_ids = [
    '29b22a39-42b8-4710-9203-ec2e08b6ab7d',  # Butterfly Pea Soda
    'c8737508-3aff-4101-a0d1-d3f670b48272',  # Lemon Soda
    'abac2dbb-9ef9-45c5-9bb5-922c6794cf49',  # Orange Soda
    '289e3770-83d4-4fbe-9993-07ed9c2eafd9',  # Passion Fruit Soda
    'd7a11678-d28c-4b34-84c8-a82946300aa4',  # Ribena Tonic
]
for sid in soda_ids:
    delete_item(sid)

# Create single Soda entry
soda_groups = make_variant_groups([
    {'group': 'Flavor', 'type': 'single', 'options': [
        {'name': 'Butterfly Pea', 'price': 0},
        {'name': 'Lemon', 'price': 0},
        {'name': 'Orange', 'price': 0},
        {'name': 'Passion Fruit', 'price': 0},
        {'name': 'Ribena Tonic', 'price': 0},
    ]}
])

dynamodb.put_item(TableName=TABLE, Item={
    'PK': {'S': 'MENU#soda-001'},
    'SK': {'S': 'META'},
    'menuItemId': {'S': 'soda-001'},
    'name': {'S': '🥤 Soda (Iced)'},
    'category': {'S': 'DRINK'},
    'basePrice': {'N': '5'},
    'variantGroups': soda_groups,
    'variants': {'L': []},
    'isActive': {'BOOL': True},
    'isEnabledToday': {'BOOL': True},
    'celebrationEligible': {'BOOL': True},
    'imageUrl': {'NULL': True},
})
print('  Created Soda (Iced) entry')

print("\nDone! Migration complete.")
